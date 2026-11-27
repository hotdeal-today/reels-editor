// blogflow.js — 블로그 URL 하나로 '글 + 사진'을 프로젝트에 담는 공통 흐름
//  AI 세팅 탭과 내보내기 탭이 같은 함수를 써서 상태가 어긋나지 않게 합니다.
import { state, persist, getAsset } from './state.js';
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
  // 같은 글을 다시 불러올 때 사진을 또 새로 넣으면 카드 사진 목록에 같은 사진이 두 번 생깁니다.
  // 같은 주소의 사진은 앞서 받아 둔 자산을 그대로 씁니다.
  const prev = loadBlogStore();
  const reuse = new Map();
  const reuseByName = new Map();
  if (prev && prev.url && prev.url === post.url) {
    for (const it of prev.images || []) {
      if (!it || !it.assetId || !getAsset(it.assetId)) continue;
      if (it.url) reuse.set(it.url, it.assetId);
      if (it.name) reuseByName.set(it.name, it.assetId);
    }
  }
  const images = [];
  const skippedSmall = [];
  for (const f of files) {
    try {
      const known = (f.url && reuse.get(f.url)) || (f.file && reuseByName.get(f.file.name)) || '';
      if (known && getAsset(known)) {
        images.push({ assetId: known, caption: f.caption || '', section: f.section || '', name: getAsset(known).name || '', url: f.url });
        continue;
      }
      const { asset } = await importMediaFile(f.file);
      // 너무 작은 이미지(공지 배너·버튼 등)는 카드·컷에서 빼기
      const w = asset.width || 0;
      const h = asset.height || 0;
      if (w && h && ((w < 620 && h < 400) || w < 400)) {
        skippedSmall.push({ url: String(f.url || '').slice(0, 160), w, h });
        await forgetAsset(asset.id).catch(() => {});
        continue;
      }
      images.push({
        assetId: asset.id,
        caption: f.caption || '',
        section: f.section || '',
        name: asset.name || '',
        url: f.url || '',
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
  // 진단용 — 어떤 사진이 왜 빠졌는지 콘솔 없이도 볼 수 있게 남깁니다.
  if (typeof window !== 'undefined') {
    window.__reelsBlogLast = {
      url: post.url, found: post.images.length, requested: want, loaded: images.length,
      failed: failed.map((f) => ({ url: String(f.url || '').slice(0, 160), message: f.message })),
      skippedSmall,
    };
  }
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
    failed: Math.max(0, failed.length),            // 내려받기 실패
    skipped: Math.max(0, skippedSmall.length),     // 공지 배너 등 작아서 뺐음
  };
}

export { loadBlogStore };
