import { Resend } from 'resend';

// Lazy initialize Resend client
let resend = null;

const getResendClient = () => {
  if (!resend) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY environment variable is not set');
    }
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
};

// Email template for quotation
const getQuotationEmailTemplate = (emailData) => {
  const {
    customerName = 'Sir/Ma\'am',
    quotationAmount = '-',
    otc = '-',
    arc = '-',
    bandwidth = '-',
    companyName = '',
    products = [],
    numberOfIPs = '',
    location = '',
    senderName = '',
    senderDesignation = '',
    senderPhone = '',
    senderEmail = ''
  } = emailData;

  // Build product list items
  const productListItems = products.length > 0
    ? products.map((p, i) => `
      <tr><td style="padding:2px 0;font-size:14px;color:#1e293b;"><strong>${String.fromCharCode(65 + i)}.</strong>&nbsp;&nbsp;<strong>${p}</strong></td></tr>
    `).join('')
    : '';

  // Service highlights
  const highlights = [
    'Last Mile Fiber Connectivity',
    'Dedicated Service Assurance Manager',
    'Escalation Matrix',
    'Managed Services',
    'Proactive Monitoring from NOC',
    '24x7 NOC Support',
    'Customer Portal',
    'Route Optimization For Latency Critical Requirements',
    'SLA and TAT'
  ];

  const highlightRows = highlights.map(h => `
    <tr><td style="padding:3px 0;font-size:14px;color:#1e293b;">&#9989;&nbsp; ${h}</td></tr>
  `).join('');

  return `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 0;">
      <tr>
        <td align="center">
          <table width="680" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
            <!-- Header -->
            <tr>
              <td style="background:linear-gradient(135deg,#7c3aed,#6d28d9);padding:28px 32px;border-radius:8px 8px 0 0;">
                <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:0.3px;">
                  Proposal of Internet Lease Line (1:1)${companyName ? ` &ndash; ${companyName}` : ''}
                </h1>
                <p style="margin:6px 0 0;color:#e9d5ff;font-size:13px;">Gazon Communications India Ltd.</p>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:32px;">

                <!-- Greeting -->
                <p style="font-size:15px;color:#1e293b;margin:0 0 20px;">Dear ${customerName},</p>

                <p style="font-size:14px;color:#1e293b;margin:0 0 16px;"><strong>Greetings from Gazon Communications India Ltd!!</strong></p>

                <p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 16px;">
                  As per our discussion regarding the ILL requirement${location ? ` for ${location}` : ''}, please check the attached Minutes of Meeting and below mentioned revised commercial.
                </p>

                <!-- Company Intro -->
                <p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 12px;">
                  <strong style="color:#1e293b;">Gazon Communications India Ltd.</strong> is one of the leading Internet Service providers in the Enterprise Domain. Our ILL (Internet Lease Line) connects your Enterprise on a robust mesh network topology over fiber. With our proactive monitoring team from NOC support services, we manage your business connectivity.
                </p>

                <p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 28px;">
                  We provide Data with Managed services and IPsec VPN to large, medium and small enterprises through our wide optic fiber network, channel partner network and dedicated sales and service teams.
                </p>

                <!-- Commercial Table -->
                <p style="font-size:15px;color:#1e293b;margin:0 0 12px;font-weight:700;text-decoration:underline;">Commercial For ILL :</p>
                <table width="100%" style="border-collapse:collapse;margin:0 0 28px;">
                  <tr>
                    <td style="background:#7c3aed;border:1px solid #6d28d9;padding:10px 12px;color:#ffffff;font-weight:700;font-size:13px;text-align:center;width:50px;">Sr No</td>
                    <td style="background:#7c3aed;border:1px solid #6d28d9;padding:10px 12px;color:#ffffff;font-weight:700;font-size:13px;text-align:center;">Location</td>
                    <td style="background:#7c3aed;border:1px solid #6d28d9;padding:10px 12px;color:#ffffff;font-weight:700;font-size:13px;text-align:center;">Bandwidth</td>
                    <td style="background:#7c3aed;border:1px solid #6d28d9;padding:10px 12px;color:#ffffff;font-weight:700;font-size:13px;text-align:center;">Services</td>
                    <td style="background:#7c3aed;border:1px solid #6d28d9;padding:10px 12px;color:#ffffff;font-weight:700;font-size:13px;text-align:center;">Connectivity</td>
                    <td style="background:#7c3aed;border:1px solid #6d28d9;padding:10px 12px;color:#ffffff;font-weight:700;font-size:13px;text-align:center;">Annual Recurring Charges</td>
                    <td style="background:#7c3aed;border:1px solid #6d28d9;padding:10px 12px;color:#ffffff;font-weight:700;font-size:13px;text-align:center;">OTC</td>
                  </tr>
                  <tr>
                    <td style="border:1px solid #e2e8f0;padding:10px 12px;text-align:center;color:#334155;font-size:13px;">1</td>
                    <td style="border:1px solid #e2e8f0;padding:10px 12px;text-align:center;color:#334155;font-size:13px;">${location || '-'}</td>
                    <td style="border:1px solid #e2e8f0;padding:10px 12px;text-align:center;color:#334155;font-size:13px;font-weight:600;">${bandwidth}</td>
                    <td style="border:1px solid #e2e8f0;padding:10px 12px;text-align:center;color:#334155;font-size:13px;">Standard (1:1)</td>
                    <td style="border:1px solid #e2e8f0;padding:10px 12px;text-align:center;color:#334155;font-size:13px;">Fiber</td>
                    <td style="border:1px solid #e2e8f0;padding:10px 12px;text-align:center;color:#334155;font-size:13px;font-weight:600;">${arc}</td>
                    <td style="border:1px solid #e2e8f0;padding:10px 12px;text-align:center;color:#334155;font-size:13px;font-weight:600;">${otc}</td>
                  </tr>
                </table>

                <!-- Service Highlights -->
                <p style="font-size:15px;color:#1e293b;margin:0 0 10px;font-weight:700;">Our Service Key Highlights;</p>
                <table style="margin:0 0 28px;border:0;" cellspacing="0" cellpadding="0">
                  ${highlightRows}
                </table>

                ${products.length > 0 ? `
                <!-- Products -->
                <p style="font-size:15px;color:#1e293b;margin:0 0 8px;font-weight:700;">Products</p>
                <table style="margin:0 0 20px;border:0;" cellspacing="0" cellpadding="0">
                  ${productListItems}
                </table>
                ` : ''}

                <!-- Enterprise Description -->
                <p style="font-size:14px;color:#334155;margin:0 0 6px;font-weight:600;">Products and Solution for Enterprise</p>

                <p style="font-size:14px;color:#1e293b;margin:0 0 6px;font-weight:700;">Internet Leased Line</p>
                <p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 16px;">
                  Dedicated Internet Lease Line is always ensuring reliable high speed communications when it is about multiple concurrent users accessing your office internet. A shared or broadband connectivity may not be able to serve your purpose and business requirement the way it can be done through Dedicated (1:1) Internet Lease Line.
                </p>

                <p style="font-size:14px;color:#1e293b;margin:0 0 6px;font-weight:700;">IP SEC VPN (Virtual Private Network)</p>
                <p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 16px;">
                  When you have multiple business locations, you need your own private network which is not only seamless but safe and secure. With our IP Sec VPN solution we ensure your business transactions with encryption. This guarantees safety and security of your data.
                </p>

                <p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 16px;">
                  We help you optimize your business with a fully meshed network to ensure fail-safe connectivity. With our mobile and managed solutions, authorized personnel may connect to business networks from anywhere including remote locations. We provide both wireline and wireless solution.
                </p>

                <p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 8px;">
                  We look forward to long-term business association with your esteemed organization.
                </p>
                <p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 8px;">
                  For more details please check attached capability presentation of Gazon Communications India Ltd.
                </p>
                <p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 28px;">
                  Assuring you the best of services.
                </p>

                <!-- Signature -->
                <div style="margin-top:24px;padding-top:20px;border-top:2px solid #7c3aed;">
                  <p style="margin:0 0 4px;font-size:14px;color:#1e293b;"><strong>Best regards,</strong></p>
                  ${senderName ? `
                  <p style="margin:12px 0 2px;font-size:14px;color:#1e293b;">
                    <strong style="color:#7c3aed;">${senderName}</strong>${senderDesignation ? ` | ${senderDesignation}` : ''}
                  </p>
                  ` : ''}
                  <p style="margin:0 0 2px;font-size:13px;color:#475569;">Gazon Communications India Ltd.</p>
                  ${senderPhone ? `<p style="margin:0 0 2px;font-size:13px;color:#475569;">&#128222; ${senderPhone}</p>` : ''}
                  ${senderEmail ? `<p style="margin:0;font-size:13px;color:#475569;">&#9993; <a href="mailto:${senderEmail}" style="color:#7c3aed;text-decoration:none;">${senderEmail}</a></p>` : ''}
                </div>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="background:#f8f5ff;padding:16px 24px;border-radius:0 0 8px 8px;border-top:1px solid #e9d5ff;">
                <p style="margin:0;font-size:12px;color:#7c3aed;text-align:center;font-weight:500;">
                  Gazon Communications India Ltd. &bull; Enterprise Internet Solutions
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();
};

/**
 * Send an email with automatic retry and exponential backoff.
 * Retries up to maxRetries times on transient failures before propagating the error.
 */
async function sendWithRetry(emailOptions, maxRetries = 3) {
  const resendClient = getResendClient();
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { data, error } = await resendClient.emails.send(emailOptions);
      if (error) {
        throw new Error(error.message);
      }
      return data;
    } catch (err) {
      console.error(`Email send attempt ${attempt}/${maxRetries} failed:`, err.message);
      if (attempt === maxRetries) {
        throw err;
      }
      // Exponential backoff: 1s, 2s, 4s
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt - 1) * 1000));
    }
  }
}

// Send email using Resend
export const sendEmail = async ({
  to,
  cc = [],
  subject,
  emailData,
  attachments = []
}) => {
  try {
    // Validate required fields
    if (!to || !subject) {
      throw new Error('Missing required fields: to and subject are required');
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(to)) {
      throw new Error('Invalid recipient email format');
    }

    // Validate CC emails if provided
    if (cc.length > 0) {
      for (const ccEmail of cc) {
        if (!emailRegex.test(ccEmail)) {
          throw new Error(`Invalid CC email format: ${ccEmail}`);
        }
      }
    }

    // Generate HTML content from template
    const htmlContent = getQuotationEmailTemplate(emailData);

    // Prepare attachments for Resend
    const resendAttachments = [];
    for (const attachment of attachments) {
      if (attachment.url) {
        try {
          // Fetch the file from URL
          const response = await fetch(attachment.url);
          if (response.ok) {
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            resendAttachments.push({
              filename: attachment.filename || 'attachment',
              content: buffer
            });
          }
        } catch (fetchError) {
          console.error('Failed to fetch attachment:', attachment.url, fetchError);
          // Continue without this attachment
        }
      }
    }

    // Prepare email options
    const emailOptions = {
      from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
      to: [to],
      subject,
      html: htmlContent
    };

    // Add CC if provided
    if (cc.length > 0) {
      emailOptions.cc = cc;
    }

    // Add attachments if any
    if (resendAttachments.length > 0) {
      emailOptions.attachments = resendAttachments;
    }

    // Send email via Resend with automatic retry
    const data = await sendWithRetry(emailOptions);

    return {
      success: true,
      resendId: data?.id,
      htmlSnapshot: htmlContent
    };
  } catch (error) {
    console.error('Email service error:', error);
    throw error;
  }
};

export default {
  sendEmail,
  getQuotationEmailTemplate
};
