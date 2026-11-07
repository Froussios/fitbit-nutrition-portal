// Google's answer arrives on this page with tokens in the URL, so the page must load no other scripts.
// It only answers the window that opened it, because froussios.github.io is shared with other Pages sites.
(() => {
  const answer = Object.fromEntries([...new URLSearchParams(location.search), ...new URLSearchParams(location.hash.slice(1))]);
  history.replaceState(null, "", location.pathname);
  if (!window.opener) {
    document.getElementById("message").textContent = "Could not finish signing in. Close this tab and try again from the Food Diary.";
    return;
  }
  window.opener.postMessage({ type: "google-sign-in", answer }, location.origin);
  window.close();
})();
