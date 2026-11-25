// assets.js — 자산 참조 확인/정리
import { state, removeAsset } from './state.js';
import { forgetAsset as forgetMediaAsset } from './media.js';
import { idbDel } from './db.js';

export function isAssetUsed(id) {
  const p = state.project;
  if (!p) return false;
  if (p.clips.some((c) => c.assetId === id)) return true;
  if (p.audio.narration && p.audio.narration.assetId === id) return true;
  if (p.audio.bgm && p.audio.bgm.assetId === id) return true;
  if ((p.audio.sfx || []).some((s) => s.key === id)) return true;
  return false;
}

export async function forgetAsset(id) {
  if (!id) return;
  forgetMediaAsset(id);
  removeAsset(id);
  try { await idbDel('assets', id); } catch (e) {}
}
