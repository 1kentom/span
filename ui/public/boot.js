// Runs before the app bundle: applies the theme saved by the last run (see src/lib/startup.ts)
// so boot.css paints the right canvas colour on the first frame.
(function () {
  try {
    var theme = window.localStorage.getItem("span.theme");
    if (theme === "dark" || theme === "light" || theme === "purple") document.documentElement.dataset.theme = theme;
  } catch (error) {
    // Storage can be unavailable; the dark default applies.
  }
})();
