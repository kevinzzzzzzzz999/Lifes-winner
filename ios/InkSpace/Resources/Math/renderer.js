"use strict";

// Native callers pass values as WKWebView arguments, never as executable source.
window.inkSpaceRender = async function (latexText, fontSize, colorHex, backgroundHex = "#FFFFFF") {
  const element = document.getElementById("formula");
  if (typeof latexText !== "string" || latexText.length > 20000) {
    return { error: "公式为空或超过 20,000 字符。" };
  }
  if (!Number.isFinite(fontSize) || fontSize < 8 || fontSize > 96) {
    return { error: "公式字号应在 10–96 之间。" };
  }
  if (!/^#[0-9a-f]{6}$/i.test(colorHex) || !/^#[0-9a-f]{6}$/i.test(backgroundHex)) {
    return { error: "公式颜色无效。" };
  }
  document.body.style.backgroundColor = backgroundHex;
  element.style.backgroundColor = backgroundHex;
  element.style.fontSize = fontSize + "px";
  element.style.color = colorHex;
  try {
    katex.render(latexText, element, {
      displayMode: true,
      throwOnError: true,
      trust: false,
      strict: "warn",
      maxExpand: 1000,
      maxSize: 50,
      output: "htmlAndMathml"
    });
    // The native renderer is intentionally offscreen. WebKit can suspend animation
    // frames there, so use synchronous layout to request fonts, then await fonts.
    element.getBoundingClientRect();
    await document.fonts.ready;
    const bounds = element.getBoundingClientRect();
    const width = Math.ceil(bounds.width);
    const height = Math.ceil(bounds.height);
    if (width > 4096 || height > 4096 || width * height > 4000000) {
      return { error: "公式过大，请拆分成多个公式卡片。" };
    }
    return { width, height };
  } catch (error) {
    element.textContent = latexText;
    return { error: String(error && error.message ? error.message : error) };
  }
};
