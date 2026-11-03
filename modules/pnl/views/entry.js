'use strict';
import { loadingHtml } from './common.js';
/** 待 T15 實作；category ∈ pending｜food｜labor｜controllable｜uncontrollable｜revenue */
export function mountEntry(el) { el.innerHTML = loadingHtml('填資料建置中'); }
