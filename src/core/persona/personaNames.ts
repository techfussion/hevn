export const PERSONA_NAMES = {
  masculine: ["Theo", "Kai", "Milo", "Nash"],
  feminine: ["Vera", "Nadia", "Lena", "Iris"],
} as const;

export const ALL_PERSONA_NAMES = [...PERSONA_NAMES.masculine, ...PERSONA_NAMES.feminine];