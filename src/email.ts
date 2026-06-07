import type { AppConfig } from './config.js'

export type EmailMessage = {
  to: string
  subject: string
  text: string
  html?: string
}

export function emailDeliveryReady(config: AppConfig) {
  return config.emailEnabled && !!config.resendApiKey && !!config.alertFromEmail
}

export async function sendEmail(config: AppConfig, message: EmailMessage) {
  if (!emailDeliveryReady(config)) {
    throw new Error('Email delivery is not configured. Set EMAIL_ENABLED=true, RESEND_API_KEY, and ALERT_FROM_EMAIL.')
  }

  const body: Record<string, unknown> = {
    from: config.alertFromName ? `${config.alertFromName} <${config.alertFromEmail}>` : config.alertFromEmail,
    to: [message.to],
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
  }
  if (config.alertReplyToEmail) body.reply_to = config.alertReplyToEmail

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Resend rejected the alert: ${response.status} ${detail}`.trim())
  }
}
