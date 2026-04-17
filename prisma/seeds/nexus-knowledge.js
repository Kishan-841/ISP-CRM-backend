/**
 * NEXUS Knowledge Base seed.
 *
 * Rule: every entry authored here is tagged with "__seeded__".
 * On every run, we delete all entries with that tag and recreate them.
 * Admin-created entries in the UI are preserved.
 */

const SEED_TAG = '__seeded__';

const entries = [
  // ============================================================
  // TIER 1 — BOTH audience (general)
  // ============================================================
  {
    title: 'What is this CRM?',
    audience: 'BOTH',
    roles: [],
    tags: ['overview', 'getting-started'],
    content: `This is the internal CRM for an Internet Service Provider (ISP). It handles the complete customer lifecycle:

- Lead generation & sales (campaigns, calling, qualification)
- Feasibility & document verification
- Billing & payments (invoices, GST, payments, credit notes)
- Installation & delivery of hardware
- Post-sale service (complaints, plan changes, renewals)

Every role in the company has their own view of the system tuned to the work they do.`,
  },
  {
    title: 'Glossary — key terms you will hear',
    audience: 'BOTH',
    roles: [],
    tags: ['glossary', 'terminology'],
    content: `**ISR** — Inside Sales Rep. Makes the first calls on campaign data.
**BDM** — Business Development Manager. Qualifies leads that ISRs surface.
**SAM** — Service Account Manager. Owns the customer relationship after sale.
**NOC** — Network Operations Center. Configures the actual internet connection.
**Feasibility** — Team that checks if we can physically deliver service at a customer location.
**OTC** — One-Time Charge (installation, setup fee).
**MRC** — Monthly Recurring Charge (the plan fee).
**Demo Plan** — A temporary trial plan before the real plan activates.
**Actual Plan** — The paid plan that the customer signed up for.
**Circuit ID** — Unique identifier for a customer's internet circuit.
**Ledger** — Append-only record of every invoice, payment, and credit for a customer.`,
  },
  {
    title: 'How to log in',
    audience: 'BOTH',
    roles: [],
    tags: ['auth', 'login'],
    content: `Staff log in at the main login page using their company email and password. Customers use the separate Customer Portal login with the username and password shared during account setup. If you have forgotten your password, contact your admin — VECTRA cannot reset passwords.`,
  },
  {
    title: 'How to log out',
    audience: 'BOTH',
    roles: [],
    tags: ['auth'],
    content: `Click your avatar or profile icon in the top-right header and select **Logout**. Your session will end immediately.`,
  },
  {
    title: 'I am stuck — who do I contact?',
    audience: 'BOTH',
    roles: [],
    tags: ['help', 'support'],
    content: `Start with VECTRA — describe what you were doing and the exact error or blocker. If VECTRA cannot resolve it, contact your team lead. For technical issues (login, page errors, missing data), escalate to your admin or the Super Admin.`,
  },
  {
    title: 'What can VECTRA help with?',
    audience: 'BOTH',
    roles: [],
    tags: ['nexus', 'help'],
    content: `VECTRA answers **"how do I..."** and **"what is..."** questions about this CRM. VECTRA can walk you through workflows step by step, explain terminology, and help you get unstuck on a page. VECTRA cannot take actions on your behalf, read your inbox, or answer unrelated questions.`,
  },
  {
    title: 'What do the bell icon notifications mean?',
    audience: 'BOTH',
    roles: [],
    tags: ['notifications', 'ui'],
    content: `The bell icon in the header shows your unread notifications. You get notifications when:
- Data or a lead is assigned to you
- A follow-up call is due in the next hour
- An approval action is needed
- A complaint is assigned to you

Click a notification to jump to the related record. Click the "Mark all read" option to clear the badge count.`,
  },
  {
    title: 'How do GST and billing work at a high level?',
    audience: 'BOTH',
    roles: [],
    tags: ['billing', 'gst', 'invoice'],
    content: `Invoices apply GST at **9% SGST + 9% CGST = 18%** by default. Every customer has a plan with a billing cycle (monthly, quarterly, half-yearly, annually). Invoices are generated automatically at 1 AM every day for customers whose next cycle is due. Each invoice has a unique number in the format **GLL/DD/MM/YY-XXXX**.`,
  },
  {
    title: 'How do complaints flow through the system?',
    audience: 'BOTH',
    roles: [],
    tags: ['complaint', 'workflow'],
    content: `1. A complaint is created — either by support staff or by the customer from their portal.
2. It gets a category, subcategory, priority, and TAT (turnaround time).
3. It is assigned to a team or specific user.
4. The assignee investigates and takes action.
5. The complaint is closed with a **Reason for outage**, **Resolution**, and **Resolution type**.
6. The customer can view the status in their portal.`,
  },
  {
    title: 'Privacy and data handling basics',
    audience: 'BOTH',
    roles: [],
    tags: ['privacy', 'security'],
    content: `Customer data (name, phone, address, ID proofs) is sensitive. Never share customer information outside authorized workflows. Never export data without a business reason. Audit logs track who viewed and changed records. Report any suspected misuse to your admin immediately.`,
  },
  {
    title: 'Dark mode and themes',
    audience: 'BOTH',
    roles: [],
    tags: ['ui', 'theme'],
    content: `Click the sun/moon icon in the top-right header to toggle between light and dark mode. Your preference is saved per device.`,
  },
  {
    title: 'How to search anything',
    audience: 'BOTH',
    roles: [],
    tags: ['search', 'ui'],
    content: `Most list pages (Leads, Customers, Invoices, Complaints) have a **search bar at the top**. You can type a name, phone, company, invoice number, or complaint ID. For unified customer lookup across the whole system, use **Customer 360** from the sidebar.`,
  },

  // ============================================================
  // TIER 2 — STAFF audience (general, no role filter)
  // ============================================================
  {
    title: 'Dashboard overview for staff',
    audience: 'STAFF',
    roles: [],
    tags: ['dashboard', 'staff'],
    content: `Your dashboard shows the widgets that matter for **your role**. An ISR sees calling queues and follow-ups; an Accounts user sees outstanding and collections; an admin sees team-wide KPIs. The left sidebar gives you navigation to every page you are allowed to access.`,
  },
  {
    title: 'Understanding "queue" pages',
    audience: 'STAFF',
    roles: [],
    tags: ['queue', 'workflow'],
    content: `A **queue** is a list of items waiting for you or your team to act on. Each stage in the lead pipeline has a queue (Feasibility Queue, Docs Queue, Accounts Queue, etc.). Sidebar badge counts update in real time — when the count goes up, it means new work has arrived for you. Click the queue to see the items and take action.`,
  },
  {
    title: 'Using the notification dropdown',
    audience: 'STAFF',
    roles: [],
    tags: ['notifications', 'ui'],
    content: `Click the bell icon to open the notification dropdown. Unread notifications are highlighted. Click any notification to navigate to the related record. The dropdown shows the last 10; go to the Notifications page for the full history.`,
  },
  {
    title: 'How to upload a document to a lead',
    audience: 'STAFF',
    roles: [],
    tags: ['documents', 'upload'],
    content: `Open the lead, scroll to the **Documents** section, choose the document type (PAN, GST certificate, address proof, etc.), and upload the file. Accepted types: PDF, JPG, PNG, DOC, DOCX. Max size: 10 MB per file. You can also generate a **public upload link** to let the customer upload documents directly.`,
  },
  {
    title: 'I see "Access denied" on a page — why?',
    audience: 'STAFF',
    roles: [],
    tags: ['access', 'roles'],
    content: `Your user role does not have permission to view that page. This is intentional — only specific teams can access specific workflows (e.g., only NOC can configure a customer account). If you need access, speak to your admin.`,
  },
  {
    title: 'How sidebar badge counts are calculated',
    audience: 'STAFF',
    roles: [],
    tags: ['ui', 'counts'],
    content: `Badges next to sidebar items show the number of **pending items in your queue**. They are updated live via a real-time socket connection — no refresh needed. If the socket disconnects, counts also refresh every 5 minutes automatically and when you return to the browser tab.`,
  },

  // ============================================================
  // TIER 3 — Role-filtered
  // ============================================================

  // ------- ISR -------
  {
    title: 'ISR: How to start a campaign call',
    audience: 'STAFF',
    roles: ['ISR'],
    tags: ['isr', 'calling'],
    content: `1. Open the **Calling Queue** from the sidebar. This lists the campaign data assigned to you.
2. Click a contact to open their record.
3. Click **Start Call** — this logs the call start time.
4. Have the conversation.
5. When done, click **End Call** and select a **disposition** (Interested / Not Interested / Call Later / Converted / DNC).
6. Add notes and a follow-up date if the disposition requires one.`,
  },
  {
    title: 'ISR: How to disposition a call',
    audience: 'STAFF',
    roles: ['ISR'],
    tags: ['isr', 'disposition'],
    content: `After ending a call, pick one of the dispositions:
- **Interested** — move to Converted workflow or schedule a follow-up
- **Not Interested** — closes the record
- **Call Later** — set a follow-up date/time; the record goes to your Retry Queue
- **Do Not Call** — marks the contact as DNC permanently
- **Converted** — the contact becomes a lead in the sales pipeline

Always add a short note explaining the outcome.`,
  },
  {
    title: 'ISR: How to schedule a follow-up',
    audience: 'STAFF',
    roles: ['ISR'],
    tags: ['isr', 'follow-up'],
    content: `When you choose **Call Later** as the disposition, set the follow-up date and time. You will get a notification one hour before the scheduled time. Missed follow-ups appear in the **Follow-Ups** sidebar item.`,
  },
  {
    title: 'ISR: How to convert a contact into a lead',
    audience: 'STAFF',
    roles: ['ISR'],
    tags: ['isr', 'conversion'],
    content: `When a customer is ready to sign up:
1. Disposition the call as **Converted**.
2. Fill in the customer's company, address, requirement, and preferred plan.
3. Submit — the contact moves out of your calling queue and becomes a lead in the sales pipeline.
4. A BDM will be assigned automatically. You can track the lead in the **Leads** page.`,
  },
  {
    title: 'ISR: How to mark a contact as Do Not Call (DNC)',
    audience: 'STAFF',
    roles: ['ISR'],
    tags: ['isr', 'dnc'],
    content: `If the contact explicitly asks never to be called again, disposition the call as **Do Not Call**. This flags the contact permanently. No one on the team can call them again from this CRM. Be respectful — once DNC is set, it should not be reversed.`,
  },
  {
    title: 'ISR: How to use the bulk import feature',
    audience: 'STAFF',
    roles: ['ISR', 'BDM'],
    tags: ['isr', 'bulk-import'],
    content: `1. Go to **Campaigns → Add Data**.
2. Download the Excel template.
3. Fill in name, phone, company, email, and any notes for each contact.
4. Upload the completed file.
5. The system validates the data and imports contacts into the selected campaign.
6. You can view imported contacts in the campaign's data tab.

Duplicates (same phone + same campaign) are skipped automatically.`,
  },
  {
    title: 'ISR: What the dashboard metrics mean',
    audience: 'STAFF',
    roles: ['ISR'],
    tags: ['isr', 'dashboard'],
    content: `Your ISR dashboard shows:
- **Calls today** — calls you completed today
- **Pending queue** — contacts still to call
- **Follow-ups due** — scheduled callbacks
- **Converted** — leads you created
- **Connect rate** — % of attempted calls that connected

Aim for a healthy connect rate and timely follow-ups.`,
  },
  {
    title: 'ISR: What to do about missed follow-ups',
    audience: 'STAFF',
    roles: ['ISR'],
    tags: ['isr', 'follow-up'],
    content: `Missed follow-ups are in the **Follow-Ups** sidebar item, highlighted. Call them as soon as possible and re-disposition. Missed follow-ups also show on the BDM's monitoring view, so don't let them pile up.`,
  },

  // ------- BDM -------
  {
    title: 'BDM: The BDM queue explained',
    audience: 'STAFF',
    roles: ['BDM'],
    tags: ['bdm', 'queue'],
    content: `Your BDM queue contains leads that ISRs have converted and assigned to you. Each lead starts with status **NEW**. Your job is to qualify the opportunity and move it to the next stage (feasibility).`,
  },
  {
    title: 'BDM: How to qualify a lead',
    audience: 'STAFF',
    roles: ['BDM'],
    tags: ['bdm', 'qualification'],
    content: `1. Open the lead from your queue.
2. Review contact details and requirement.
3. Contact the customer to confirm interest and gather details (location, bandwidth need, budget).
4. Use the **Disposition** action:
   - **Qualified** — move forward to feasibility
   - **Dropped** — customer is not a fit; add a reason
   - **Follow-up** — needs more nurture; set a date

Only qualified leads should be pushed to feasibility.`,
  },
  {
    title: 'BDM: How to set a follow-up date',
    audience: 'STAFF',
    roles: ['BDM'],
    tags: ['bdm', 'follow-up'],
    content: `When you disposition a lead as **Follow-up**, pick a date and time. You will receive a notification one hour before. Missed follow-ups appear in your Follow-Ups view.`,
  },
  {
    title: 'BDM: How to push a lead to feasibility',
    audience: 'STAFF',
    roles: ['BDM'],
    tags: ['bdm', 'feasibility'],
    content: `Once a lead is qualified:
1. Open the lead.
2. Ensure location/address details are complete.
3. Click **Push to Feasibility**.
4. A Feasibility team member will be notified and will take over.
5. The lead moves out of your queue; you can still track it in **Leads**.`,
  },
  {
    title: 'BDM: What the sidebar counts mean',
    audience: 'STAFF',
    roles: ['BDM'],
    tags: ['bdm', 'counts'],
    content: `- **BDM Queue** — new leads awaiting qualification
- **Follow-Ups** — leads waiting for your callback today/tomorrow
- **Meetings** — scheduled customer meetings

Counts update live.`,
  },
  {
    title: 'BDM: How the lead lifecycle continues after you',
    audience: 'STAFF',
    roles: ['BDM'],
    tags: ['bdm', 'workflow'],
    content: `After you push to feasibility, the lead flows through:
Feasibility → Docs Verification → Accounts Verification → OPS Approval → NOC (account creation) → Delivery (hardware) → Speed test & customer acceptance → Plan activation → Invoicing.

You can track the lead's current stage on the lead detail page.`,
  },

  // ------- FEASIBILITY -------
  {
    title: 'Feasibility: Your queue',
    audience: 'STAFF',
    roles: ['FEASIBILITY_TEAM'],
    tags: ['feasibility', 'queue'],
    content: `The Feasibility queue shows leads that BDMs have pushed for your review. Your job is to check whether service can be physically delivered at the customer's address.`,
  },
  {
    title: 'Feasibility: How to mark a lead feasible or not feasible',
    audience: 'STAFF',
    roles: ['FEASIBILITY_TEAM'],
    tags: ['feasibility', 'disposition'],
    content: `1. Open the lead and review the address and requirement.
2. Cross-check coverage/infra.
3. Use the **Feasibility Disposition** action:
   - **Feasible** — lead advances to Docs Verification
   - **Not Feasible** — lead is closed; add reason
4. You must add notes explaining the decision, especially for **Not Feasible**.`,
  },
  {
    title: 'Feasibility: Required fields before disposition',
    audience: 'STAFF',
    roles: ['FEASIBILITY_TEAM'],
    tags: ['feasibility', 'fields'],
    content: `Before you can mark a lead feasible, the lead must have:
- Complete customer address
- Service/bandwidth requirement
- Contact person phone

If any are missing, push the lead back to the BDM with a note.`,
  },
  {
    title: 'Feasibility: How to push a lead back to BDM',
    audience: 'STAFF',
    roles: ['FEASIBILITY_TEAM'],
    tags: ['feasibility', 'push-back'],
    content: `If essential info is missing, click **Push back to BDM** on the lead page, add a clear reason, and submit. The lead returns to the BDM's queue with your note attached. The BDM completes the info and resubmits.`,
  },

  // ------- DOCS -------
  {
    title: 'Docs: Documents required from a customer',
    audience: 'STAFF',
    roles: ['DOCS_TEAM'],
    tags: ['docs', 'verification'],
    content: `Standard required documents:
- **PAN card** (mandatory)
- **GST certificate** (for business customers)
- **Address proof** (electricity bill, rental agreement, etc.)
- **Authorized signatory ID**
- **Bank details / cancelled cheque** (for auto-debit)

Additional documents may be required by the Accounts team.`,
  },
  {
    title: 'Docs: How to verify or reject a document',
    audience: 'STAFF',
    roles: ['DOCS_TEAM'],
    tags: ['docs', 'verification'],
    content: `1. Open the lead's **Documents** tab.
2. For each document, click **Preview** to view the file.
3. Verify name, company, numbers against the lead record.
4. Click **Approve** or **Reject**. On reject, add a reason — this is sent to the BDM and customer.
5. Once all required docs are approved, the lead advances to Accounts Verification.`,
  },
  {
    title: 'Docs: How to request a re-upload from the customer',
    audience: 'STAFF',
    roles: ['DOCS_TEAM'],
    tags: ['docs', 'upload-link'],
    content: `1. On the lead page, click **Generate Upload Link**.
2. Choose the document type(s) needed.
3. The system creates a secure, time-limited public link.
4. Share the link with the customer via email/WhatsApp.
5. When the customer uploads, you receive a notification.`,
  },
  {
    title: 'Docs: Handling expired upload links',
    audience: 'STAFF',
    roles: ['DOCS_TEAM'],
    tags: ['docs', 'upload-link'],
    content: `Upload links expire after a fixed period (default 7 days). If the customer says the link is expired, simply generate a new one from the lead page and resend.`,
  },

  // ------- OPS -------
  {
    title: 'Ops: What Ops approval does',
    audience: 'STAFF',
    roles: ['OPS_TEAM'],
    tags: ['ops', 'approval'],
    content: `Ops approval is the final commercial/operational sign-off before a lead becomes a paying customer. You confirm the commercials match the quotation, the customer is ready, and downstream teams can proceed.`,
  },
  {
    title: 'Ops: How to approve or reject a lead',
    audience: 'STAFF',
    roles: ['OPS_TEAM'],
    tags: ['ops', 'disposition'],
    content: `1. Open the lead from your Ops queue.
2. Review commercials, docs, and Accounts verification result.
3. Click **Approve** — lead advances to NOC for account creation. Or click **Reject** with a reason.
4. Approval triggers notifications to NOC and SAM teams.`,
  },
  {
    title: 'Ops: What happens after you approve',
    audience: 'STAFF',
    roles: ['OPS_TEAM'],
    tags: ['ops', 'workflow'],
    content: `After Ops approval:
1. NOC receives the lead and creates the customer account (username, password, IP, circuit ID).
2. Delivery team schedules hardware dispatch.
3. After install + speed test + customer acceptance, the plan activates.
4. Invoicing begins on the next billing cycle.`,
  },
  {
    title: 'Ops: Things to check before approving',
    audience: 'STAFF',
    roles: ['OPS_TEAM'],
    tags: ['ops', 'checklist'],
    content: `- All documents are verified
- Accounts verification is complete (GST, PAN)
- Quoted plan matches customer's agreed plan
- OTC and MRC are correctly set
- Billing cycle and payment terms are captured`,
  },

  // ------- ACCOUNTS -------
  {
    title: 'Accounts: How to generate an invoice manually',
    audience: 'STAFF',
    roles: ['ACCOUNTS_TEAM'],
    tags: ['accounts', 'invoice'],
    content: `Usually invoices are auto-generated daily at 1 AM. If you need one manually:
1. Open the lead or customer.
2. Click **Invoices → Generate Invoice**.
3. Select billing period, plan, adjustments if any.
4. Review the GST calculation (9% SGST + 9% CGST).
5. Click **Generate**. Invoice number format: **GLL/DD/MM/YY-XXXX**.`,
  },
  {
    title: 'Accounts: How to generate an OTC invoice',
    audience: 'STAFF',
    roles: ['ACCOUNTS_TEAM'],
    tags: ['accounts', 'invoice', 'otc'],
    content: `OTC (One-Time Charge) invoices cover installation, setup, or hardware. Open the customer → **Invoices → Generate OTC Invoice**. Enter the OTC amount, description, and select the GST treatment. OTC invoices are separate from recurring plan invoices.`,
  },
  {
    title: 'Accounts: How to record a payment',
    audience: 'STAFF',
    roles: ['ACCOUNTS_TEAM'],
    tags: ['accounts', 'payment'],
    content: `1. Open the invoice.
2. Click **Add Payment**.
3. Enter amount, payment mode (Cheque / NEFT / Online / TDS), reference number, payment date.
4. Upload payment proof if available.
5. Submit — the invoice status updates (Partially Paid / Paid), and the ledger is updated.`,
  },
  {
    title: 'Accounts: How to bulk-pay multiple invoices',
    audience: 'STAFF',
    roles: ['ACCOUNTS_TEAM'],
    tags: ['accounts', 'payment', 'bulk'],
    content: `For a single payment covering multiple invoices:
1. Open the customer's invoice list.
2. Select the invoices using the checkboxes.
3. Click **Bulk Pay**.
4. Enter total amount and payment mode. The system distributes the payment across the selected invoices in order.`,
  },
  {
    title: 'Accounts: How to record an advance payment',
    audience: 'STAFF',
    roles: ['ACCOUNTS_TEAM'],
    tags: ['accounts', 'advance-payment'],
    content: `Advance payments are collected before an invoice exists. On the customer page → **Advance Payments → Record Advance**. Enter amount, mode, and reference. The advance balance auto-applies against future invoices until exhausted.`,
  },
  {
    title: 'Accounts: How to create a credit note',
    audience: 'STAFF',
    roles: ['ACCOUNTS_TEAM'],
    tags: ['accounts', 'credit-note'],
    content: `Credit notes offset an invoice when a refund or adjustment is due. Open the invoice → **Create Credit Note**. Pick a reason:
- Service downtime
- Overpayment
- Price adjustment
- Cancellation
- Error correction
- Plan downgrade

Enter amount and notes. A CN number is generated (format CN/DD/MM/YY-XXXX) and the ledger is updated.`,
  },
  {
    title: 'Accounts: How to view a customer ledger',
    audience: 'STAFF',
    roles: ['ACCOUNTS_TEAM'],
    tags: ['accounts', 'ledger'],
    content: `The ledger shows every invoice (debit), payment (credit), credit note (credit), and refund (debit) for a customer, with a running balance. Open the customer → **Ledger** tab. Entries are **append-only** — they cannot be edited, only offset by new entries.`,
  },
  {
    title: 'Accounts: Handling overdue invoices',
    audience: 'STAFF',
    roles: ['ACCOUNTS_TEAM'],
    tags: ['accounts', 'overdue', 'collections'],
    content: `Invoices past their due date are marked **Overdue** by the system at 1 AM daily. Check the **Accounts Dashboard → Ageing Report** to see overdue by bucket (0-30, 31-60, 60+). Use **Collection Calls** to log outreach. Escalate long-overdue accounts to the SAM team.`,
  },

  // ------- DELIVERY -------
  {
    title: 'Delivery: Delivery request flow',
    audience: 'STAFF',
    roles: ['DELIVERY_TEAM'],
    tags: ['delivery', 'workflow'],
    content: `1. NOC creates a Delivery Request after customer account creation.
2. It needs **Super Admin approval** first.
3. Then **Area Head approval** based on location.
4. Store is assigned → items are dispatched.
5. Installation completes → speed test → customer acceptance.`,
  },
  {
    title: 'Delivery: How to view delivery requests',
    audience: 'STAFF',
    roles: ['DELIVERY_TEAM'],
    tags: ['delivery', 'queue'],
    content: `Open **Delivery Requests** in the sidebar. Filter by stage (Pending / Super Admin Approved / Area Head Approved / Assigned / Dispatched / Completed). Click a request to see items, approvals, and history.`,
  },
  {
    title: 'Delivery: How to mark items dispatched',
    audience: 'STAFF',
    roles: ['DELIVERY_TEAM', 'STORE_MANAGER', 'STORE_ADMIN'],
    tags: ['delivery', 'dispatch'],
    content: `On an approved delivery request:
1. Confirm the items and quantity.
2. For serialized items, scan or enter each serial number.
3. Click **Mark Dispatched**.
4. The customer gets notified; the request advances to the installation team.`,
  },
  {
    title: 'Delivery: How to mark a delivery as complete',
    audience: 'STAFF',
    roles: ['DELIVERY_TEAM'],
    tags: ['delivery', 'complete'],
    content: `After installation and customer acceptance:
1. Open the delivery request.
2. Click **Mark Complete**.
3. Upload the signed delivery challan if required.
4. The customer's plan activation is triggered automatically.`,
  },

  // ------- NOC -------
  {
    title: 'NOC: How to create a customer account',
    audience: 'STAFF',
    roles: ['NOC_TEAM'],
    tags: ['noc', 'account'],
    content: `After Ops approval, the lead appears in your NOC queue.
1. Open the lead.
2. Click **Create Customer Account**.
3. Assign username, password, static/dynamic IP, and circuit ID.
4. Save — the customer can now log in to the portal and the delivery process begins.`,
  },
  {
    title: 'NOC: How to assign a demo plan',
    audience: 'STAFF',
    roles: ['NOC_TEAM'],
    tags: ['noc', 'demo-plan'],
    content: `A demo plan is a temporary trial before the actual plan activates.
1. On the lead/customer page, click **Assign Demo Plan**.
2. Pick plan bandwidth, validity, start date.
3. Confirm — the demo plan is active and the customer can browse.`,
  },
  {
    title: 'NOC: How to activate the actual (paid) plan',
    audience: 'STAFF',
    roles: ['NOC_TEAM'],
    tags: ['noc', 'actual-plan'],
    content: `Once speed test passes and customer accepts:
1. Open the lead.
2. Click **Activate Actual Plan**.
3. Confirm plan, MRC, and start date.
4. The demo plan is replaced. The system will begin generating invoices on the configured billing cycle.`,
  },
  {
    title: 'NOC: Speed test and customer acceptance',
    audience: 'STAFF',
    roles: ['NOC_TEAM'],
    tags: ['noc', 'speed-test'],
    content: `After installation, run a speed test:
1. Upload the speed test screenshot to the lead.
2. Share results with the customer.
3. Customer clicks **Accept** in the portal (or you record acceptance on their behalf with proof).
4. Actual plan activation becomes available.`,
  },

  // ------- SAM EXECUTIVE -------
  {
    title: 'SAM: The SAM queue',
    audience: 'STAFF',
    roles: ['SAM_EXECUTIVE'],
    tags: ['sam', 'queue'],
    content: `Your SAM queue lists the customers assigned to you. These are paying customers you nurture post-sale — meetings, visits, renewals, upsells, complaint oversight.`,
  },
  {
    title: 'SAM: How to schedule a meeting',
    audience: 'STAFF',
    roles: ['SAM_EXECUTIVE'],
    tags: ['sam', 'meeting'],
    content: `1. Open the customer.
2. Click **Schedule Meeting**.
3. Pick type (review, escalation, sales, renewal), date/time, participants.
4. Save — a reminder is added to your calendar view.
5. After the meeting, click **Log Minutes** to record outcomes.`,
  },
  {
    title: 'SAM: How to log a customer visit',
    audience: 'STAFF',
    roles: ['SAM_EXECUTIVE'],
    tags: ['sam', 'visit'],
    content: `For in-person visits:
1. Open the customer → **Visits → Log Visit**.
2. Pick visit type (site survey, escalation, service), date, and status.
3. Add notes, photos, or action items.
4. Submit — the visit appears in the customer's timeline.`,
  },
  {
    title: 'SAM: How to log customer communication',
    audience: 'STAFF',
    roles: ['SAM_EXECUTIVE'],
    tags: ['sam', 'communication'],
    content: `Log every call, email, or message with the customer:
1. Customer page → **Communications → Log**.
2. Pick type, channel (phone, email, whatsapp), status.
3. Add summary.

This builds the customer's relationship history.`,
  },
  {
    title: 'SAM: How to view the Customer 360',
    audience: 'STAFF',
    roles: ['SAM_EXECUTIVE', 'SAM_HEAD'],
    tags: ['sam', 'customer-360'],
    content: `Customer 360 is a unified view: profile, plan, invoices, payments, complaints, meetings, visits, communications. Open **Customer 360** from the sidebar, search by name/phone/customer username, and click a customer to see everything in one place.`,
  },
  {
    title: 'SAM: Creating an upgrade or downgrade service order',
    audience: 'STAFF',
    roles: ['SAM_EXECUTIVE'],
    tags: ['sam', 'service-order'],
    content: `When a customer wants to change their plan:
1. Customer page → **Service Orders → Create**.
2. Type = Upgrade / Downgrade / Rate Revision / Disconnection.
3. Pick the new plan and effective date.
4. Submit. The order goes through approvals (SAM Head, then Accounts, then NOC).
5. Once processed, the customer's plan updates, and pro-rated billing kicks in.`,
  },
  {
    title: 'SAM: Handling disconnection requests',
    audience: 'STAFF',
    roles: ['SAM_EXECUTIVE'],
    tags: ['sam', 'disconnection'],
    content: `1. Customer page → **Service Orders → Create → Type: Disconnection**.
2. Add reason (category + subcategory) and effective date.
3. Submit for approval. Final invoices and refund (if any) are handled by Accounts.`,
  },
  {
    title: 'SAM: Contract renewal reminders',
    audience: 'STAFF',
    roles: ['SAM_EXECUTIVE', 'SAM_HEAD'],
    tags: ['sam', 'renewal'],
    content: `The system alerts you at **30, 15, and 7 days** before contract expiry. Notifications go to you (SAM Executive) and at the 30-day mark also to SAM_HEAD. Reach out to the customer, propose renewal terms, and create a service order if needed.`,
  },

  // ------- SAM_HEAD -------
  {
    title: 'SAM Head: Team oversight',
    audience: 'STAFF',
    roles: ['SAM_HEAD'],
    tags: ['sam-head', 'oversight'],
    content: `You oversee the SAM team. Use **Team Dashboard & Reports** to see SAM Executive activity — meetings logged, visits completed, complaints closed, renewal outcomes. Drill into specific executives to review their pipeline.`,
  },
  {
    title: 'SAM Head: Approving service orders',
    audience: 'STAFF',
    roles: ['SAM_HEAD'],
    tags: ['sam-head', 'service-order'],
    content: `Service orders created by SAM Executives need your approval (for upgrades/downgrades above a threshold). Open **Service Orders → Pending Approval**. Review pricing, effective date, and customer reason. Approve or reject with notes.`,
  },
  {
    title: 'SAM Head: Escalation handling',
    audience: 'STAFF',
    roles: ['SAM_HEAD'],
    tags: ['sam-head', 'escalation'],
    content: `Critical complaints and long-overdue accounts escalate to you. Check **Complaints (Critical)** and **Ageing Report (60+ days)**. Coordinate with the executive and Accounts team to resolve or drive collection.`,
  },

  // ------- STORE -------
  {
    title: 'Store: How to create a purchase order',
    audience: 'STAFF',
    roles: ['STORE_ADMIN', 'STORE_MANAGER'],
    tags: ['store', 'po'],
    content: `1. Sidebar → **Store → Purchase Orders → New PO**.
2. Select vendor, add line items (product, quantity, rate, GST).
3. Submit — the PO enters the approval chain (admin → super admin).
4. Once approved, items can be received.`,
  },
  {
    title: 'Store: How to approve a PO',
    audience: 'STAFF',
    roles: ['STORE_MANAGER'],
    tags: ['store', 'po', 'approval'],
    content: `Open the PO, review items and vendor. Click **Approve**. If something is wrong, click **Reject** with a reason — the PO returns to the creator. Fully approved POs are ready for goods receipt.`,
  },
  {
    title: 'Store: How to receive goods against a PO',
    audience: 'STAFF',
    roles: ['STORE_ADMIN', 'STORE_MANAGER'],
    tags: ['store', 'grn'],
    content: `1. Open the approved PO.
2. Click **Receive Goods**.
3. Enter actual quantities received (can be partial).
4. For serialized items, scan/enter each serial number.
5. Submit — a GRN is logged and stock is added to inventory.`,
  },
  {
    title: 'Store: Inventory overview',
    audience: 'STAFF',
    roles: ['STORE_ADMIN', 'STORE_MANAGER'],
    tags: ['store', 'inventory'],
    content: `**Store → Inventory** shows current stock by product. Filters: store location, status (available / allocated / dispatched). Drill into any product to see serial numbers and movement history.`,
  },
  {
    title: 'Store: Tracking serialized items',
    audience: 'STAFF',
    roles: ['STORE_ADMIN', 'STORE_MANAGER'],
    tags: ['store', 'serials'],
    content: `Serialized items (routers, ONTs, etc.) are tracked individually. Every unit has a serial number, a status (in-store / dispatched / installed / returned), and a history. Search by serial on the Inventory page.`,
  },

  // ------- SUPPORT / Complaints -------
  {
    title: 'Support: How to create a complaint',
    audience: 'STAFF',
    roles: ['SUPPORT_TEAM'],
    tags: ['complaint', 'create'],
    content: `1. Sidebar → **Complaints → New Complaint**.
2. Search for the customer.
3. Pick category → subcategory (TAT auto-fills).
4. Set priority (Low / Medium / High / Critical).
5. Add description.
6. Submit — a complaint number is generated (format **CMP/DD/MM/YY-XXXX**).`,
  },
  {
    title: 'Support: How to assign a complaint',
    audience: 'STAFF',
    roles: ['SUPPORT_TEAM'],
    tags: ['complaint', 'assign'],
    content: `On the complaint detail page, click **Assign**. Pick a user or team. The assignee is notified immediately and the complaint appears in their queue. You can re-assign later if needed.`,
  },
  {
    title: 'Support: How to close a complaint',
    audience: 'STAFF',
    roles: ['SUPPORT_TEAM'],
    tags: ['complaint', 'close'],
    content: `1. Open the complaint.
2. Click **Close Complaint**.
3. Fill in:
   - **Reason for Outage**
   - **Resolution**
   - **Resolution Type**
4. Add closing notes.
5. Submit — the customer is notified and the complaint is marked **CLOSED**.`,
  },
  {
    title: 'Support: Understanding TAT',
    audience: 'STAFF',
    roles: ['SUPPORT_TEAM'],
    tags: ['complaint', 'tat'],
    content: `TAT (Turnaround Time) is the expected resolution time per subcategory. It starts from complaint creation. If not closed before TAT, the complaint is flagged **Breached**. Critical priority complaints have the tightest TAT — handle them first.`,
  },

  // ------- AREA_HEAD -------
  {
    title: 'Area Head: Your regional view',
    audience: 'STAFF',
    roles: ['AREA_HEAD'],
    tags: ['area-head', 'region'],
    content: `You oversee leads, customers, deliveries, and complaints in your assigned region. Use dashboards filtered to your area to see pipeline, collections, and service health in your territory.`,
  },
  {
    title: 'Area Head: Approving delivery requests',
    audience: 'STAFF',
    roles: ['AREA_HEAD'],
    tags: ['area-head', 'delivery'],
    content: `Delivery requests in your region need your approval after Super Admin approval. Open **Delivery Requests → Pending Area Head Approval**. Review items, installation address, and customer. Approve or reject with a reason.`,
  },
  {
    title: 'Area Head: Team oversight',
    audience: 'STAFF',
    roles: ['AREA_HEAD'],
    tags: ['area-head', 'team'],
    content: `Use the Team Dashboard to monitor your regional team's KPIs — new leads, active installations, outstanding collections, complaints open/closed. Escalate to central leadership if region-wide issues emerge.`,
  },

  // ============================================================
  // TIER 4 — CUSTOMER portal audience
  // ============================================================
  {
    title: 'Customer: How to log in to the customer portal',
    audience: 'CUSTOMER',
    roles: [],
    tags: ['customer', 'login'],
    content: `Go to the customer portal login page. Enter your **Customer Username** and password (shared with you during account setup). Forgot your password? Contact our support team — they can reset it for you.`,
  },
  {
    title: 'Customer: How to view my current plan',
    audience: 'CUSTOMER',
    roles: [],
    tags: ['customer', 'plan'],
    content: `Click **My Plan** in the sidebar. You'll see:
- Current plan name and bandwidth
- Billing cycle and next renewal date
- Monthly charge (MRC)
- Plan status (Active / Demo / Paused)`,
  },
  {
    title: 'Customer: How to view and download invoices',
    audience: 'CUSTOMER',
    roles: [],
    tags: ['customer', 'invoice'],
    content: `Click **Invoices** in the sidebar. You'll see all your invoices with status (Paid / Unpaid / Overdue). Click any invoice to view details or click **Download PDF** to save a copy.`,
  },
  {
    title: 'Customer: How to make a payment',
    audience: 'CUSTOMER',
    roles: [],
    tags: ['customer', 'payment'],
    content: `Go to **Invoices** → click an unpaid invoice → **Pay Now**. Choose a payment method (online transfer, UPI, card — as available). After payment, share the transaction reference with our Accounts team so the invoice can be marked paid.`,
  },
  {
    title: 'Customer: How to view payment history',
    audience: 'CUSTOMER',
    roles: [],
    tags: ['customer', 'payments'],
    content: `Go to **Payments** in the sidebar. You'll see every payment recorded against your account, including any **advance balance** available (pre-paid amounts that will be applied to future invoices).`,
  },
  {
    title: 'Customer: How to file a complaint',
    audience: 'CUSTOMER',
    roles: [],
    tags: ['customer', 'complaint'],
    content: `Click **Complaints → New Complaint**. Pick a category (e.g., Service Down, Slow Speed, Billing). Add a description. Submit — you'll get a complaint ID like **CMP/27/01/26-0001**. Our support team will investigate and update you.`,
  },
  {
    title: 'Customer: How to check a complaint status',
    audience: 'CUSTOMER',
    roles: [],
    tags: ['customer', 'complaint-status'],
    content: `Go to **Complaints**. You'll see all your complaints with status (Pending / Open / Closed). Click a complaint to see the latest update, assigned team, and resolution notes (once closed).`,
  },
  {
    title: 'Customer: How to submit a referral or enquiry',
    audience: 'CUSTOMER',
    roles: [],
    tags: ['customer', 'enquiry'],
    content: `Click **Enquiries → New Enquiry**. Fill in the contact details and their service need. Submit — our sales team will follow up. Status updates appear in your Enquiries list.`,
  },
  {
    title: 'Customer: How to update my contact details',
    audience: 'CUSTOMER',
    roles: [],
    tags: ['customer', 'profile'],
    content: `Click **My Details**. You can view your profile and contact info. To update anything, raise an enquiry or contact support — your account manager will confirm and apply the changes.`,
  },
];

export async function seedNexusKnowledge(prisma) {
  // Remove previously seeded entries (preserve admin-created ones)
  const deleted = await prisma.nexusKnowledge.deleteMany({
    where: { tags: { has: SEED_TAG } },
  });

  // Tag every entry with the seed marker
  const data = entries.map((e) => ({
    ...e,
    tags: [...(e.tags || []), SEED_TAG],
  }));

  await prisma.nexusKnowledge.createMany({ data });

  console.log(`[seed] NEXUS knowledge base: removed ${deleted.count} old seeded entries, inserted ${data.length} new ones`);
}
