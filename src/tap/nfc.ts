// Squeezebox Tap — NFC tag writing (Web NFC).
//
// Reading a tag at tap-time needs ZERO code here: a URL-type NDEF tag is opened
// natively by the phone OS, which navigates the browser to the tap URL. We only
// WRITE tags, via Chrome-on-Android's `NDEFReader` (Android + HTTPS + a user
// gesture only; iOS/desktop can't write but can still read finished tags).
//
// Tests stub `globalThis.NDEFReader` with a mock to exercise the write path
// headlessly; production uses the real browser global.

export type NfcWriteResult = { ok: true } | { ok: false; reason: string };

type NdefReaderLike = { write(message: { records: { recordType: string; data: string }[] }): Promise<void> };
type NdefReaderCtor = new () => NdefReaderLike;

function getNdefReader(): NdefReaderCtor | undefined {
  return (globalThis as { NDEFReader?: NdefReaderCtor }).NDEFReader;
}

export function isNfcWriteSupported(): boolean {
  return typeof getNdefReader() !== "undefined";
}

export async function writeTapTag(url: string): Promise<NfcWriteResult> {
  if (!url) return { ok: false, reason: "no-url" };
  const Ctor = getNdefReader();
  if (!Ctor) return { ok: false, reason: "unsupported" };
  try {
    const reader = new Ctor();
    await reader.write({ records: [{ recordType: "url", data: url }] });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "write-failed" };
  }
}
