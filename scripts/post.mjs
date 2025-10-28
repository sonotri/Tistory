// scripts/post.mjs
import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { marked } from "marked";

const mdPath = process.env.MD_PATH;
const blogUrl = process.env.TISTORY_BLOG_URL;
const storageB64 = process.env.TISTORY_STORAGE_B64;

function fatal(m) {
  console.error(m);
  process.exit(1);
}
if (!mdPath) fatal("MD_PATH env missing.");
if (!blogUrl) fatal("TISTORY_BLOG_URL env missing.");
if (!storageB64) fatal("TISTORY_STORAGE_B64 secret missing.");
if (!fs.existsSync(mdPath)) fatal(`MD not found: ${mdPath}`);

const md = fs.readFileSync(mdPath, "utf8");
const html = marked.parse(md);
const h1 = md.match(/^#\s+(.+)$/m)?.[1];
let title = (h1 || path.basename(mdPath, ".md")).trim().slice(0, 80);

const storageJson = Buffer.from(storageB64, "base64").toString("utf8");
fs.writeFileSync("storageState.json", storageJson);
await fs.promises.mkdir("screenshots", { recursive: true }).catch(() => {});

const browser = await chromium.launch();
const context = await browser.newContext({
  storageState: "storageState.json",
  recordVideo: { dir: ".", size: { width: 1280, height: 800 } },
});
const page = await context.newPage();
async function snap(n) {
  try {
    await page.screenshot({ path: `screenshots/${n}.png`, fullPage: true });
  } catch {}
}

console.log("[INFO] Target blog:", blogUrl);
console.log("[INFO] Title:", title);
console.log("[INFO] MD:", mdPath);

try {
  // 0) 로그인 확인
  await page.goto(`${blogUrl}/manage`, {
    waitUntil: "networkidle",
    timeout: 60000,
  });
  await snap("01-manage");
  if (
    page.url().includes("auth/login") ||
    page.url().includes("accounts.kakao")
  )
    throw new Error(
      "Not logged in (session expired). Recreate TISTORY_STORAGE_B64."
    );

  // 1) 글쓰기 페이지 오픈 (여러 후보 URL)
  const writeUrls = [
    `${blogUrl}/manage/post/write`,
    `${blogUrl}/manage/newpost`,
    `${blogUrl}/manage/post`, // 환경별 우회
  ];
  let ok = false;
  for (const u of writeUrls) {
    await page
      .goto(u, { waitUntil: "networkidle", timeout: 60000 })
      .catch(() => {});
    await snap("02-write");
    if (!page.url().includes("auth/login")) {
      ok = true;
      break;
    }
  }
  if (!ok) throw new Error("Cannot open write page");

  // 2) DOM 힌트 로그 (제목/버튼 후보들을 찍어줌)
  await page.evaluate(() => {
    const info = [];
    document.querySelectorAll("input,textarea,button").forEach((el) => {
      const tag = el.tagName.toLowerCase();
      const ph = el.getAttribute("placeholder") || "";
      const nm = el.getAttribute("name") || "";
      const id = el.id || "";
      const cls = (el.className || "").toString().slice(0, 120);
      const txt = (el.textContent || "").trim().slice(0, 30);
      info.push({ tag, ph, nm, id, cls, txt });
    });
    console.log("@@DOM_HINT@@", JSON.stringify(info));
  });

  // 3) 제목 입력 (시도 폭 확대)
  const titleSelectors = [
    'input[placeholder*="제목"]',
    'textarea[placeholder*="제목"]',
    'input[name="title"]',
    'textarea[name="title"]',
    "#title",
    "#post-title",
    "#article-title",
    'input[class*="title"]',
    'textarea[class*="title"]',
  ];
  let setTitle = false;
  for (const sel of titleSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.fill(title);
      setTitle = true;
      break;
    }
  }
  if (!setTitle)
    console.log("제목 입력 필드를 찾지 못했습니다. 에디터 셀렉터 확인 필요");
  await snap("03-title");

  // 4) 본문 입력 (iframe/다양한 에디터 후보)
  let injected = false;
  // 4-1) iframe 우선
  const iframes = await page.$$("iframe");
  for (const ifr of iframes) {
    const f = await ifr.contentFrame();
    if (!f) continue;
    try {
      await f.evaluate((content) => {
        const cands = [
          '[contenteditable="true"]',
          "#tinymce",
          ".notion-page-content",
          ".se2_inputarea",
          "body",
        ];
        for (const c of cands) {
          const node = document.querySelector(c);
          if (node) {
            node.innerHTML = content;
            return;
          }
        }
        throw new Error("no editor in frame");
      }, html);
      injected = true;
      break;
    } catch {}
  }

  // 4-2) 페이지 내 contenteditable/textarea 후보
  if (!injected) {
    const editorCands = [
      '[contenteditable="true"]',
      ".editor-content",
      ".se2_inputarea",
      "#editor",
      ".tistoryEditor",
      'div[role="textbox"]',
      'textarea[name="content"]',
      "textarea#content",
    ];
    for (const sel of editorCands) {
      const el = await page.$(sel);
      if (el) {
        await page.$eval(
          sel,
          (n, c) => {
            n.innerHTML ? (n.innerHTML = c) : (n.value = c);
          },
          html
        );
        injected = true;
        break;
      }
    }
  }
  if (!injected)
    console.log("본문 편집 영역을 찾지 못했습니다. 에디터 셀렉터 확인 필요");
  await snap("04-body");

  // 5) 발행 버튼 클릭 (텍스트/데이터속성 다양한 후보)
  const publishSelectors = [
    'button:has-text("발행")',
    'button:has-text("공개")',
    'button:has-text("등록")',
    'button:has-text("출간")',
    'button:has-text("쓰기")',
    '[data-action="publish"]',
    ".btn_publish",
    "button.publish",
  ];
  let clicked = false;
  for (const sel of publishSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.click();
      clicked = true;
      break;
    }
  }
  if (!clicked)
    console.log("발행 버튼을 찾지 못했습니다. 에디터 셀렉터 확인 필요");
  await snap("05-after-click");

  // 6) 발행 검증 (목록에서 제목 찾기)
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.goto(`${blogUrl}/manage/posts`, {
    waitUntil: "networkidle",
    timeout: 60000,
  });
  await snap("06-posts");
  const tabs = ["전체", "발행", "임시저장", "예약"];
  let found = false;
  for (const t of tabs) {
    const btn = await page.$(`text=${t}`);
    if (btn) {
      await btn.click().catch(() => {});
      await page.waitForLoadState("networkidle").catch(() => {});
      await snap(`06-tab-${t}`);
    }
    const visible = await page
      .locator(`text="${title}"`)
      .first()
      .isVisible()
      .catch(() => false);
    if (visible) {
      found = true;
      break;
    }
  }
  if (!found) {
    const dump = await page.content();
    fs.writeFileSync("page.html", dump, "utf8");
    await snap("07-not-found");
    throw new Error("Post not found after publish (maybe draft/modal).");
  }

  console.log("업로드 완료:", title);
} catch (e) {
  console.error("[ERROR]", e.message);
  try {
    const dump = await page.content();
    fs.writeFileSync("page.html", dump, "utf8");
  } catch {}
  await browser.close();
  process.exit(1);
}
await browser.close();
