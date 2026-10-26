/** Display names only. Persistent IDs, formats and .inkspace paths keep their legacy names. */
export const ENGLISH_BRAND = "Life's Winner";
export const CHINESE_BRAND = '人生赢家';
export const displayBrand = (locale:string) => locale.toLowerCase().startsWith('zh') ? CHINESE_BRAND : ENGLISH_BRAND;
