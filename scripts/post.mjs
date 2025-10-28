import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { marked } from "marked";

// 입력: 업로드할 MD 경로
const mdPath = process.env.MD_PATH; // publish.yml에서 넘겨줌
if (!mdPath) {
  console.error("MD_PATH env가 비어있습니다.");
  process.exit(1);
}
const blogUrl = process.env.sonowhstudy.tistory.com; // 예: https://fuzzlab.tistory.com
if (!blogUrl) {
  console.error("TISTORY_BLOG_URL env가 비어있습니다.");
  process.exit(1);
}

// 1) MD 읽기 & HTML 변환
const md = fs.readFileSync(mdPath, "utf8");
const html = marked.parse(md);

// 제목: MD 첫 번째 H1 또는 파일명
let title = (md.match(/^#\s+(.+)$/m)?.[1] || path.basename(mdPath, ".md"))
  .trim()
  .slice(0, 80);

// 2) storageState 복원
const storageB64 = process.env.TISTORY_STORAGE_B64;
if (!storageB64) {
  console.error("TISTORY_STORAGE_B64 secret 필요");
  process.exit(1);
}
const storageJson = Buffer.from(storageB64, "base64").toString("utf8");
fs.writeFileSync("storageState.json", storageJson);

// 3) 브라우저 실행
const browser = await chromium.launch();
const context = await browser.newContext({ storageState: "storageState.json" });
const page = await context.newPage();

// 4) 글쓰기 페이지 이동 (에디터 주소는 블로그/환경에 따라 조금 다름)
await page.goto(`${blogUrl}/manage/post/write`, { waitUntil: "networkidle" });

// ------------------------------
// 에디터 셀렉터는 블로그/스킨/에디터 버전에 따라 달라질 수 있음.
// 아래는 2가지 공략법을 섞어둠:
//
// (A) 제목 입력 필드 찾기
// (B) 본문 편집 iframe/body에 HTML 주입
// ------------------------------

// (A) 제목 입력 시도 (여러 후보 셀렉터 중 존재하는 것 사용)
const titleSelectors = [
  'input[placeholder="제목"]',
  "input.title",
  'input[class*="title"]',
  'input[name="title"]',
];
let titleSet = false;
for (const sel of titleSelectors) {
  const el = await page.$(sel);
  if (el) {
    await el.fill(title);
    titleSet = true;
    break;
  }
}
if (!titleSet) {
  console.warn("제목 입력 필드를 찾지 못했습니다. 에디터 셀렉터 확인 필요");
}

// (B) 본문 주입: iframe 기반/에디터 div 기반 모두 시도
// 1) iframe이 있다면 그 안의 body에 주입
const iframe = await page.$("iframe");
if (iframe) {
  const frame = await iframe.contentFrame();
  if (frame) {
    await frame.evaluate((content) => {
      // contenteditable body/루트 찾기
      const body =
        document.querySelector('body[contenteditable="true"], body') ||
        document.body;
      body.innerHTML = content;
    }, html);
  }
} else {
  // 2) iframe이 없다면 현재 페이지에서 contenteditable 요소 찾기
  const editorCandidates = [
    '[contenteditable="true"]',
    ".editor-content",
    ".se2_inputarea", // 구 에디터 케이스
    "#editor", // 커스텀
  ];
  let injected = false;
  for (const sel of editorCandidates) {
    const el = await page.$(sel);
    if (el) {
      await page.$eval(
        sel,
        (node, content) => {
          node.innerHTML = content;
        },
        html
      );
      injected = true;
      break;
    }
  }
  if (!injected) {
    console.warn("본문 편집 영역을 찾지 못했습니다. 에디터 셀렉터 확인 필요");
  }
}

// (선택) 태그/카테고리 입력 셀렉터가 있으면 여기에 추가로 입력/선택 로직 작성
// 예:
// await page.fill('input[name="tags"]', '티스토리,자동화,블로그');
// await page.selectOption('select[name="category"]', '3'); // 카테고리 ID

// (C) 발행 버튼 클릭 (여러 후보 셀렉터 중 가능한 것 사용)
const publishSelectors = [
  'button:has-text("발행")',
  "button.publish",
  'button:has-text("공개")',
  'button:has-text("확인")',
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
if (!clicked) {
  console.warn("발행 버튼을 찾지 못했습니다. 에디터 셀렉터 확인 필요");
}

// 발행 후 잠시 대기
await page.waitForTimeout(3000);

await browser.close();
console.log("업로드 완료:", title);
