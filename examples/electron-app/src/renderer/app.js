const loadButton = document.querySelector("#load-notes");
const notesList = document.querySelector("#notes");

loadButton.addEventListener("click", async () => {
  const notes = await window.desktopNotes.list({ workspaceId: "inbox" });
  notesList.replaceChildren(
    ...notes.map((note) => {
      const item = document.createElement("li");
      item.textContent = note.title;
      return item;
    }),
  );
});
