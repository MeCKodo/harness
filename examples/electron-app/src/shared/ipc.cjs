const NOTES_LIST_CHANNEL = "notes:list";

function isNotesListRequest(value) {
  return Boolean(value && typeof value === "object" && typeof value.workspaceId === "string" && value.workspaceId.length > 0);
}

module.exports = { NOTES_LIST_CHANNEL, isNotesListRequest };
