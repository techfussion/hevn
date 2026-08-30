/**
 * User Identity & Conversational Name Resolution Service.
 * Implements conversational priority rules to ensure HEVN addresses users naturally,
 * concisely, and without repetitive full legal name usage.
 */

export interface UserIdentityProfile {
  preferredName?: string | null;
  displayName?: string | null;
  username?: string | null;
  fullName?: string | null;
  namelessMode?: boolean;
}

export class UserIdentityService {
  /**
   * Resolves the user's conversational name following the strict precedence:
   * 1. If namelessMode is active -> returns null (never use name).
   * 2. If preferredName is provided -> returns preferredName.
   * 3. If displayName is provided -> extracts first name (e.g., "Raji Abdulmumin" -> "Raji").
   * 4. If username is provided -> returns cleaned username without "@".
   * 5. If fullName is provided -> extracts first name.
   * 6. Fallback -> null.
   */
  static resolveConversationalName(profile: UserIdentityProfile): string | null {
    if (profile.namelessMode) {
      return null;
    }

    if (profile.preferredName && profile.preferredName.trim().length > 0) {
      return profile.preferredName.trim();
    }

    if (profile.displayName && profile.displayName.trim().length > 0) {
      const parts = profile.displayName.trim().split(/\s+/);
      return parts[0] || null;
    }

    if (profile.username && profile.username.trim().length > 0) {
      const cleaned = profile.username.trim().replace(/^@/, "");
      return cleaned.length > 0 ? cleaned : null;
    }

    if (profile.fullName && profile.fullName.trim().length > 0) {
      const parts = profile.fullName.trim().split(/\s+/);
      return parts[0] || null;
    }

    return null;
  }

  /**
   * Validates and normalizes a proposed username.
   * Allowed: 3-30 alphanumeric characters and underscores. Case-insensitive.
   */
  static validateAndNormalizeUsername(raw: string): { valid: boolean; normalized?: string; error?: string } {
    if (!raw) {
      return { valid: false, error: "Username cannot be empty" };
    }

    const trimmed = raw.trim().replace(/^@/, "");

    if (trimmed.length < 3) {
      return { valid: false, error: "Username must be at least 3 characters long" };
    }

    if (trimmed.length > 30) {
      return { valid: false, error: "Username cannot exceed 30 characters" };
    }

    if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
      return { valid: false, error: "Username may only contain letters, numbers, and underscores" };
    }

    return { valid: true, normalized: trimmed.toLowerCase() };
  }

  /**
   * Generates a natural, conversational greeting that uses names sparingly and avoids robotic phrasing.
   */
  static composeGreeting(
    profile: UserIdentityProfile,
    timeOfDay: "morning" | "afternoon" | "evening" | "any" = "any"
  ): string {
    const name = this.resolveConversationalName(profile);

    if (!name) {
      switch (timeOfDay) {
        case "morning":
          return "Good morning.";
        case "afternoon":
          return "Good afternoon.";
        case "evening":
          return "Good evening.";
        default:
          return "Hello.";
      }
    }

    switch (timeOfDay) {
      case "morning":
        return `Morning, ${name}.`;
      case "afternoon":
        return `Good afternoon, ${name}.`;
      case "evening":
        return `Evening, ${name}.`;
      default:
        return `Hi ${name}.`;
    }
  }
}
