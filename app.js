const startButton = document.querySelector("#startButton");
const loaderPanel = document.querySelector("#loaderPanel");
const playerPanel = document.querySelector("#playerPanel");
const gameFile = document.querySelector("#gameFile");
const fileInfo = document.querySelector("#fileInfo");
const gameName = document.querySelector("#gameName");

startButton.addEventListener("click", () => {
  loaderPanel.classList.remove("hidden");
  loaderPanel.scrollIntoView({ behavior: "smooth", block: "start" });
});
document.querySelector("#backButton").addEventListener("click", () => {
  loaderPanel.classList.add("hidden");
  playerPanel.classList.add("hidden");
  document.querySelector("#home").scrollIntoView({ behavior: "smooth" });
});
document.querySelector("#exitButton").addEventListener("click", () => {
  playerPanel.classList.add("hidden");
  loaderPanel.classList.remove("hidden");
  loaderPanel.scrollIntoView({ behavior: "smooth", block: "start" });
});
gameFile.addEventListener("change", () => {
  const file = gameFile.files && gameFile.files[0];
  if (!file) return;
  fileInfo.textContent = "Selected: " + file.name + " · " + formatBytes(file.size);
  fileInfo.classList.remove("hidden");
  gameName.textContent = file.name;
  playerPanel.classList.remove("hidden");
  playerPanel.scrollIntoView({ behavior: "smooth", block: "start" });
});
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
// Placeholder controls: engine input events will be wired after a compatible WASM runtime is integrated.
document.querySelectorAll("[data-key]").forEach((button) => {
  const activate = () => {
    if (button.disabled) return;
    button.classList.add("pressed");
    window.setTimeout(() => button.classList.remove("pressed"), 100);
  };
  button.addEventListener("pointerdown", activate);
  button.addEventListener("contextmenu", (event) => event.preventDefault());
});