// In-process drain control. Docker's local signal API is the authenticated control
// boundary: only an operator able to control this container can request SIGUSR1.
// Participants close intake immediately; existing leased runs remain allowed to finish.
export type DrainParticipant = () => void;

const participants = new Set<DrainParticipant>();
let installed = false;

function closeParticipants(): void {
  for (const close of participants) {
    try { close(); } catch (err) { console.error(`drain participant close failed: ${(err as Error).message}`); }
  }
}

export function registerDrainParticipant(close: DrainParticipant): () => void {
  participants.add(close);
  if (!installed) {
    installed = true;
    process.on("SIGUSR1", closeParticipants);
  }
  return () => participants.delete(close);
}

/** Test-only direct equivalent of the authenticated SIGUSR1 control path. */
export function closeDrainParticipantsForTest(): void { closeParticipants(); }
