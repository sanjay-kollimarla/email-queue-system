/** Accounts made by "Explore with a demo account" use this email domain; the demo banner is shown only to them. */
export const DEMO_EMAIL_DOMAIN = "courier-demo.test";

/** Who built this. A link with an empty URL is simply not rendered, so fill the blanks in and rebuild. */
export const AUTHOR = {
  name: "Sanjay Kollimarla",
  links: [
    { label: "LinkedIn", href: "https://linkedin.com/in/kollimarla-sai-sanjay" },
    { label: "Portfolio", href: "https://sanjay-kollimarla.vercel.app/" },
    { label: "GitHub", href: "https://github.com/sanjay-kollimarla" },
    { label: "Source code", href: "https://github.com/sanjay-kollimarla/email-queue-system" },
  ],
} as const;
