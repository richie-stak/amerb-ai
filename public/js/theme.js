// Shared light/dark theme toggle used by every page. The actual switch happens via the
// [data-theme] attribute set here (style.css does the rest) — this file only owns the toggle
// control's behavior and keeping it in sync with the current state.
(function () {
  function getEffectiveTheme() {
    const stored = localStorage.getItem('amerb-theme');
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function setTheme(theme) {
    localStorage.setItem('amerb-theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
  }

  function toggleTheme() {
    const next = getEffectiveTheme() === 'dark' ? 'light' : 'dark';
    setTheme(next);
    return next;
  }

  function wireThemeToggle(btn) {
    if (!btn) return;
    function render() {
      const theme = getEffectiveTheme();
      const iconName = theme === 'dark' ? 'sun' : 'moon';
      const label = theme === 'dark' ? 'Light mode' : 'Dark mode';
      btn.innerHTML = `${window.icon(iconName, { size: 15 })} ${label}`;
    }
    btn.addEventListener('click', () => {
      toggleTheme();
      render();
    });
    render();
  }

  window.AmerbTheme = { getEffectiveTheme, setTheme, toggleTheme, wireThemeToggle };
})();
