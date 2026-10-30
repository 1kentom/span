// Runs before the app bundle: applies the theme saved by the last run (see src/lib/startup.ts)
// so boot.css paints the right canvas colour on the first frame.
(function () {
  try {
    var theme = window.localStorage.getItem("span.theme");
    if (theme === "dark" || theme === "light" || theme === "purple") document.documentElement.dataset.theme = theme;
  } catch (error) {
    // Storage can be unavailable; the dark default applies.
  }
  // Last line of defence: when the app bundle never started (src/index.tsx sets data-span-entry), show a plain,
  // readable message instead of an empty canvas. The app's own watchdog and error screen cover everything later.
  var FALLBACK_MS = 10000;
  setTimeout(function () {
    if (document.documentElement.dataset.spanEntry || !document.body) return;
    var box = document.createElement("div");
    box.className = "boot-fallback";
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-label", "span could not start");
    var card = document.createElement("div");
    card.className = "boot-fallback-card";
    var title = document.createElement("h1");
    title.textContent = "span could not start its interface";
    var text = document.createElement("p");
    text.textContent = "The interface did not load. Reload to try again. Resetting the interface state clears remembered layout only, not settings files or chats.";
    var reload = document.createElement("button");
    reload.type = "button";
    reload.textContent = "Reload";
    reload.onclick = function () { window.location.reload(); };
    var reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Reset interface state";
    reset.onclick = function () {
      try {
        var keys = [];
        for (var i = 0; i < window.localStorage.length; i++) {
          var key = window.localStorage.key(i);
          if (key && (key.indexOf("span.") === 0 || key.indexOf("span:") === 0)) keys.push(key);
        }
        for (var j = 0; j < keys.length; j++) window.localStorage.removeItem(keys[j]);
      } catch (error) {
        // Storage can be unavailable; reloading is still worth trying.
      }
      window.location.reload();
    };
    card.appendChild(title);
    card.appendChild(text);
    card.appendChild(reload);
    card.appendChild(reset);
    box.appendChild(card);
    document.body.appendChild(box);
  }, FALLBACK_MS);
})();
