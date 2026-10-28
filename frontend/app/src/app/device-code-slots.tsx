import { useRef } from "react";

import { Input } from "@meltiply/ui/input";

import { normalizeDeviceUserCode } from "@/lib/device-authorization";

/** A device user code is exactly six characters; the server generates the same length. */
export const DEVICE_USER_CODE_LENGTH = 6;

/**
 * Six single-character slots for the user-facing matching code.
 *
 * Typing advances to the next slot, Backspace clears or steps back, arrow keys
 * move between slots, and a pasted code fills from the first slot. The value is
 * always the normalized contiguous code; empty slots are display-only.
 *
 * @param props.value - Current normalized code, possibly shorter than six while typing.
 * @param props.onChange - Receives the next normalized contiguous code.
 * @returns Grouped, individually labelled one-character inputs.
 */
export function DeviceCodeSlots({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): React.ReactElement {
  const slots = useRef<Array<HTMLInputElement | null>>([]);
  const characters = Array.from(
    { length: DEVICE_USER_CODE_LENGTH },
    (_, index) => value[index] ?? "",
  );

  /**
   * Moves focus to a slot, clamped to the six inputs.
   *
   * @param index - Requested slot index.
   */
  const focusSlot = (index: number) => {
    slots.current[Math.min(DEVICE_USER_CODE_LENGTH - 1, Math.max(0, index))]?.focus();
  };

  /**
   * Applies one slot edit and advances focus.
   *
   * @param index - Edited slot.
   * @param raw - Raw input value; may contain a whole pasted code.
   */
  const updateSlot = (index: number, raw: string) => {
    const normalized = normalizeDeviceUserCode(raw);
    if (!normalized) {
      onChange(value.slice(0, index) + value.slice(index + 1));
      return;
    }
    if (normalized.length > 1) {
      onChange(normalized.slice(0, DEVICE_USER_CODE_LENGTH));
      focusSlot(Math.min(DEVICE_USER_CODE_LENGTH - 1, normalized.length - 1));
      return;
    }
    onChange(
      (value.slice(0, index) + normalized + value.slice(index + 1)).slice(
        0,
        DEVICE_USER_CODE_LENGTH,
      ),
    );
    focusSlot(index + 1);
  };

  return (
    <div role="group" aria-label="User code" className="flex justify-center gap-1.5">
      {characters.map((character, index) => (
        <Input
          key={index}
          ref={(element) => {
            slots.current[index] = element;
          }}
          aria-label={`User code character ${index + 1} of ${DEVICE_USER_CODE_LENGTH}`}
          autoCapitalize="characters"
          autoComplete={index === 0 ? "one-time-code" : "off"}
          autoCorrect="off"
          className="h-11 w-10 px-0 text-center font-mono text-lg font-semibold tracking-widest uppercase"
          inputMode="text"
          maxLength={1}
          spellCheck={false}
          value={character}
          onChange={(event) => updateSlot(index, event.target.value)}
          onFocus={() => {
            if (index > value.length) focusSlot(value.length);
          }}
          onKeyDown={(event) => {
            if (event.key === "Backspace" && !character && index > 0) {
              event.preventDefault();
              onChange(value.slice(0, index - 1) + value.slice(index));
              focusSlot(index - 1);
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              focusSlot(index - 1);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              focusSlot(index + 1);
            }
          }}
          onPaste={(event) => {
            event.preventDefault();
            const pasted = normalizeDeviceUserCode(event.clipboardData.getData("text"));
            if (!pasted) return;
            onChange(pasted.slice(0, DEVICE_USER_CODE_LENGTH));
            focusSlot(Math.min(DEVICE_USER_CODE_LENGTH - 1, pasted.length - 1));
          }}
        />
      ))}
    </div>
  );
}
