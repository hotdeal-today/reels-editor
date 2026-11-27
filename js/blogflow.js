// blogflow.js — 블로그 URL 하나로 '글 + 사진'을 프로젝트에 담는 공통 흐름
//  AI 세팅 탭과 내보내기 탭이 같은 함수를 써서 상태가 어긋나지 않게 합니다.
import { state, persist } from './state.js';
import { importMediaFile } from './media.js';
import { forgetAsset } from './assets.js';
import { fetchBlogPost, fetchBlogImages, saveBlogStore, loadBlogStore } from './blog.js';
import { saveCaptionState } from './captions.js';

/**
 * 블로그 글을 가져와 ① 사진을 자산으로 저장 ② 본문·제목을 캡션 저장소에 기록합니다.
 * @returns {Promise<{post:object, images:{assetId,caption,section}[], via:string}>}
 */
export async function loadBlogIntoProject(url, { maxImages = 0, onProgress = () => {}, setName = true } = {}) {
  const post = await fetchBlogPost(url, { onProgress });
  // maxImages가 0/없음이면 글에 있는 사진을 전부 받습니다(6장·8장 잘림 없음).
  const cap = Number(maxImages) > 0 ? Math.floor(Number(maxImages)) : 0;
  const want = cap > 0 ? Math.min(cap, post.images.length) : post.images.length;
  onProgress(`사진 ${want}장 내려받는 중…`);
  const files = await fetchBlogImages(post.images, {
    limit: cap,
    onProgress: (i, n) => { if (i < n) onProgress(`사진 ${i + 1}/${n} 내려받는 중…`); },
  });
  const failed = files.failed || [];
  const images = [];
  for (const f of files) {
    try {
      const { asset } = await importMediaFile(f.file);
      // 너무 작은 이미지(공지 배너·버튼 등)는 카드·컷에서 빼기
      const w = asset.width || 0;
      const h = asset.height || 0;
      if (w && h && ((w < 620 && h < 400) || w < 400)) {
        await forgetAsset(asset.id).catch(() => {});
        continue;
      }
      images.push({
        assetId: asset.id,
        caption: f.caption || '',
        section: f.section || '',
        name: asset.name || '',
      });
    } catch (e) { /* 사진 하나 실패는 넘어감 */ }
  }
  const title = post.title || '';
  saveBlogStore({
    url: post.url,
    title,
    body: post.body,
    hashtags: post.hashtags || [],
    images,
    at: Date.now(),
  });
  const skipped = want - images.length;
  if (skipped > 0) console.warn(`[blog] 사진 ${skipped}장을 프로젝트에 넣지 못했습니다`, { failed, skipped });
  saveCaptionState({ url: post.url, body: post.body, title });
  if (setName && state.project) {
    const cur = state.project.name || '';
    if (!cur || cur === '새 릴스' || cur === '새 프로젝트') {
      state.project.name = title.slice(0, 40);
      persist();
    }
  }
  return {
    post, images, via: post.via || '',
    found: post.images.length,   // 글에서 찾은 사진 수
    requested: want,             // 내려받기로 한 수
    loaded: images.length,       // 실제로 프로젝트에 들어간 수
    failed: Math.max(0, want - images.length),
  };
}

export { loadBlogStore };
