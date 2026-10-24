// Safari invokes this only when the user selects the share extension.
// Do not read body text, form values, cookies, or page HTML.
var ExtensionPreprocessingJS = new function () {
    this.run = function (arguments) {
        arguments.completionFunction({
            title: String(document.title || "").slice(0, 500),
            url: String(document.location.href || ""),
            text: String(window.getSelection ? window.getSelection().toString() : "").slice(0, 50000)
        });
    };
};
