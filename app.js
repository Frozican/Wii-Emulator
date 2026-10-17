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
