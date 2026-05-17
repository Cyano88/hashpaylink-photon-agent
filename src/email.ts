import type { AppConfig } from './config.js'

export type EmailMessage = {
  to: string
  subject: string
  text: string
  html?: string
}

export function emailDeliveryReady(config: AppConfig) {
  return config.emailEnabled && !!config.sendgridApiKey && !!config.alertFromEmail
}

export async function sendEmail(config: AppConfig, message: EmailMessage) {
  if (!emailDeliveryReady(config)) {
    throw new Error('Email delivery is not configured. Set EMAIL_ENABLED=true, SENDGRID_API_KEY, and ALERT_FROM_EMAIL.')
  }

  const body: Record<string, unknown> = {
    personalizations: [
      {
        to: [{ email: message.to }],
      },
    ],
    from: {
      email: config.alertFromEmail,
      name: config.alertFromName,
    },
    subject: message.subject,
    content: [
      {
        type: 'text/plain',
        value: message.text,
      },
      ...(message.html ? [{
        type: 'text/html',
        value: message.html,
      }] : []),
    ],
  }
  if (config.alertReplyToEmail) body.reply_to = { email: config.alertReplyToEmail }

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.sendgridApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`SendGrid rejected the alert: ${response.status} ${detail}`.trim())
  }
}
