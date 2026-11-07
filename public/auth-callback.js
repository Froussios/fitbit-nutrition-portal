// Google's answer arrives on this page with tokens in the URL, so the page must load no other scripts.
(() => {
  const answer = Object.fromEntries([...new URLSearchParams(location.search), ...new URLSearchParams(location.hash.slice(1))]);
  history.replaceState(null, "", location.pathname);
  const message = { type: "google-sign-in", answer };
  // Google's pages can cut the link to the window that opened this one. The channel covers that case.
  if (window.opener) {
    window.opener.postMessage({ ...message, via: "opener" }, location.origin);
  } else {
    const channel = new BroadcastChannel("food-diary-sign-in");
    channel.postMessage({ ...message, via: "channel" });
    channel.close();
  }
  window.close();
  setTimeout(() => {
    document.getElementById("message").textContent = "Signed in. You can close this tab.";
  }, 500);
})();
