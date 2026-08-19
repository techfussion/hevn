export const PERSONA_NAMES = {
  masculine: ["Raj", "Hamid", "Wali"],
  feminine: ["Khadija", "Iris", "Lena"],
} as const;

export const ALL_PERSONA_NAMES = [...PERSONA_NAMES.masculine, ...PERSONA_NAMES.feminine] as const;
export type PersonaName = (typeof ALL_PERSONA_NAMES)[number];