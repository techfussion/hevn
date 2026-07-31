export const PERSONA_NAMES = {
  masculine: ["Raj", "Hamid"],
  feminine: ["Khadija","Iris"],
} as const;

export const ALL_PERSONA_NAMES = [...PERSONA_NAMES.masculine, ...PERSONA_NAMES.feminine];