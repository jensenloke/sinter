export const CLI_INSTALL_URL = "https://github.com/jensenloke/sinter#install";
export const CLI_DOCS_URL = "https://github.com/jensenloke/sinter#quick-start";

export function dashboardFailureCopy(code: string, message: string) {
  if (code === "account-claim") {
    return {
      eyebrow: "CLOUD PRIVATE ALPHA",
      heading: "Cloud access is limited to existing members.",
      description: "This account could not be opened. No Cloud account was created, and no profile or device records were displayed.",
    };
  }
  return {
    eyebrow: "DATA CONNECTION UNAVAILABLE",
    heading: "Your account data stayed private.",
    description: `${message} No profile or device records were displayed.`,
  };
}
