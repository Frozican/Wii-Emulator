const startButton = document.querySelector("#startButton");
const loaderPanel = document.querySelector("#loaderPanel");

// The main call-to-action must open the real Gecko engine. The old local
// picker only showed a filename and the fake player panel never emulated a game.
startButton.addEventListener("click", () => {
  window.location.href = "./gecko/";
});

// Keep the legacy picker from pretending that selecting a file starts a game.
// The actual game picker is inside the Gecko engine page.
const backButton = document.querySelector("#backButton");
if (backButton) {
  backButton.addEventListener("click", () => {
    loaderPanel?.classList.add("hidden");
    document.querySelector("#home")?.scrollIntoView({ behavior: "smooth" });
  });
}


// Local NKit file checker. This intentionally does not claim to restore an image:
// a correct restore needs the NKit reconstruction algorithm and streaming output.
const restoreFile = document.querySelector("#restoreFile");
const restoreInfo = document.querySelector("#restoreInfo");
if (restoreFile && restoreInfo) {
  restoreFile.addEventListener("change", () => {
    const file = restoreFile.files?.[0];
    restoreInfo.classList.remove("hidden");
    if (!file) {
      restoreInfo.textContent = "";
      return;
    }
    const name = file.name.toLowerCase();
    const valid = name.endsWith(".nkit.iso") || name.endsWith(".nkit.gcz");
    const size = (file.size / (1024 ** 3)).toFixed(2);
    restoreInfo.textContent = valid
      ? `Selected locally: ${file.name} · ${size} GiB. No upload occurred. This page cannot convert it yet; use one of the restoration tools below.`
      : "This does not look like a legacy NKit image (.nkit.iso or .nkit.gcz). No data was uploaded or changed.";
  });
}
