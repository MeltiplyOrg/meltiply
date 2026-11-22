import { useRef } from "react";

import { Input } from "@meltiply/ui/input";

import { normalizeDeviceUserCode } from "@/lib/device-authorization";

export const DEVICE_USER_CODE_LENGTH = 6;

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

  const focusSlot = (index: number) => {
    slots.current[Math.min(DEVICE_USER_CODE_LENGTH - 1, Math.max(0, index))]?.focus();
  };

  const fillSlots = (code: string) => {
    onChange(code.slice(0, DEVICE_USER_CODE_LENGTH));
    focusSlot(code.length - 1);
  };

  const updateSlot = (index: number, raw: string) => {
    const normalized = normalizeDeviceUserCode(raw);
    if (!normalized) {
      onChange(value.slice(0, index) + value.slice(index + 1));
      return;
    }
    if (normalized.length > 1) {
      fillSlots(normalized);
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
        <div key={index} className="w-10 shrink-0">
          <Input
            ref={(element) => {
              slots.current[index] = element;
            }}
            aria-label={`User code character ${index + 1} of ${DEVICE_USER_CODE_LENGTH}`}
            autoCapitalize="characters"
            autoComplete={index === 0 ? "one-time-code" : "off"}
            autoCorrect="off"
            className="h-11 px-0 text-center font-mono text-lg font-semibold tracking-widest uppercase"
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
              if (pasted) fillSlots(pasted);
            }}
          />
        </div>
      ))}
    </div>
  );
}
