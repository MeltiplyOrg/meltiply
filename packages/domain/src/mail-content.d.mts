export function isMailSenderAddress(value: string, requireDottedDomain?: boolean): boolean;
export function isMailSenderName(value: string): boolean;
export interface MailSenderConfiguration {
  email: string;
  name?: string;
}
export function mailSenderConfiguration(env: {
  MAIL_FROM_ADDRESS?: string;
  MAIL_FROM_NAME?: string;
}): MailSenderConfiguration | undefined;
export function escapeMailHtml(value: string): string;
