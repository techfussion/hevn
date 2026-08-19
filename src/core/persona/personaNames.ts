export const ASSISTANT_NAMES = ["Mumin", "Khadijah", "Scott", "Claire"] as const;
export type AssistantNameOption = (typeof ASSISTANT_NAMES)[number];

export const USER_PERSONAS = ["student", "executive_assistant", "professional"] as const;
export type UserPersonaOption = (typeof USER_PERSONAS)[number];

// Backward-compatible alias for existing code
export const ALL_PERSONA_NAMES = [...ASSISTANT_NAMES] as const;
export type PersonaName = AssistantNameOption;