/**
 * VECTRA (NEXUS) cache pre-warming seed.
 *
 * For the most obvious questions that every user will ask on day one, we
 * write answers directly into the `NexusCache` table. When a user asks one
 * of these questions:
 *   - the regular cache lookup in nexus.service.js finds the row
 *   - the response is served with `fromCache: true`
 *   - Gemini is NEVER called (RPD preserved)
 *   - the user's daily quota is NOT decremented
 *
 * Each seeded row is tagged with `knowledgeIds: ['__seeded_cache__']` so that
 * re-running the seed wipes only its own rows and leaves organic cache
 * entries (populated by real Gemini responses) untouched.
 *
 * Cache key format MUST match buildCacheKey() in nexus.service.js exactly:
 *   CUSTOMER audience      →  `CUSTOMER|<normalized>`
 *   UNRESTRICTED roles     →  `UNRESTRICTED|STAFF|<normalized>`
 *                              (SUPER_ADMIN, ADMIN, SAM_HEAD share this bucket)
 *   Every other staff role →  `<ROLE>|STAFF|<normalized>`
 */

const SEED_MARKER = '__seeded_cache__';

// Mirror of normalizeQuery in nexus.service.js — kept in sync manually so the
// seed stays standalone (no cross-package import). If you change the stopword
// set or normalization rule here, change it in nexus.service.js too.
const QUERY_STOPWORDS = new Set([
  'how', 'what', 'when', 'where', 'why', 'which', 'who', 'whom',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'done',
  'has', 'have', 'had',
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'mine', 'we', 'our', 'us', 'ours',
  'you', 'your', 'yours', 'he', 'him', 'his', 'she', 'her', 'hers',
  'it', 'its', 'they', 'them', 'their',
  'to', 'of',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
  'as', 'if', 'so', 'than', 'then', 'too', 'also', 'just', 'only', 'like',
  'please', 'kindly',
]);

const normalize = (text) => {
  const cleaned = (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const tokens = cleaned.split(' ').filter((t) => t.length > 0 && !QUERY_STOPWORDS.has(t));
  return tokens.length ? tokens.join(' ') : cleaned;
};

const UNRESTRICTED_ROLE_NAMES = ['SUPER_ADMIN', 'ADMIN', 'SAM_HEAD', 'MASTER', 'SALES_DIRECTOR'];
const ALL_STAFF_ROLES = [
  'BDM', 'BDM_CP', 'BDM_TEAM_LEADER', 'ISR',
  'FEASIBILITY_TEAM', 'DOCS_TEAM', 'OPS_TEAM', 'ACCOUNTS_TEAM',
  'DELIVERY_TEAM', 'NOC_TEAM', 'NOC', 'NOC_HEAD',
  'SAM_EXECUTIVE', 'SAM', 'STORE_ADMIN', 'STORE_MANAGER',
  'AREA_HEAD', 'SUPPORT_TEAM', 'INSTALLATION_TEAM', 'TEST_USER',
];
// Unrestricted bucket is shared across these — seeding once as 'UNRESTRICTED' covers them all.
const UNRESTRICTED_BUCKET = ['UNRESTRICTED'];

// ─── The content ─────────────────────────────────────────────────────────
// Each entry: { audience, targetRoles, variants, answer }
//   - audience: 'STAFF' or 'CUSTOMER'
//   - targetRoles: array of bucket names for STAFF audience (ignored for CUSTOMER)
//   - variants: phrasings that all map to the same answer
//   - answer: detailed, ~100–200 words, markdown-friendly

const CACHED_QUESTIONS = [
  // ═══════════════════════════════════════════════════════════════════════
  // UNIVERSAL (every staff role + unrestricted)
  // ═══════════════════════════════════════════════════════════════════════
  {
    audience: 'STAFF',
    targetRoles: [...ALL_STAFF_ROLES, ...UNRESTRICTED_BUCKET],
    variants: [
      'how do i log in',
      'how to login',
      'how to log in',
      'login',
      'login steps',
      'how can i sign in',
    ],
    answer: `Use your company email and the password your admin provided on the main login page. If you've forgotten the password, contact your admin — VECTRA can't reset passwords. Once logged in you land on the dashboard that matches your role. Your session lasts 7 days; you'll be logged out automatically after that.`,
  },
  {
    audience: 'STAFF',
    targetRoles: [...ALL_STAFF_ROLES, ...UNRESTRICTED_BUCKET],
    variants: [
      'how do i log out',
      'how to logout',
      'logout',
      'sign out',
    ],
    answer: `Click your profile avatar in the top-right header and pick **Logout**. Your session ends immediately on every device. If you're on a shared machine, always log out when you're done.`,
  },
  {
    audience: 'STAFF',
    targetRoles: [...ALL_STAFF_ROLES, ...UNRESTRICTED_BUCKET],
    variants: [
      'what is this crm',
      'what does this system do',
      'what is the platform for',
      'overview',
      'what is isp crm',
    ],
    answer: `This is the internal CRM for an Internet Service Provider. It runs the complete customer journey:

1. **Lead generation** — campaigns, ISR calling, BDM qualification
2. **Feasibility & documents** — serviceability check, document verification
3. **Quotation & approval** — BDM quote → Sales Director approval
4. **Billing setup** — Accounts verification, GST, invoicing
5. **Installation** — NOC customer account, delivery, vendor setup
6. **Activation** — speed test, customer acceptance, actual plan
7. **Service** — post-sale SAM, complaints, upgrades, renewals

Each role sees only the screens relevant to their work.`,
  },
  {
    audience: 'STAFF',
    targetRoles: [...ALL_STAFF_ROLES, ...UNRESTRICTED_BUCKET],
    variants: [
      'how do i contact support',
      'who do i contact for help',
      'how to get help',
      'support contact',
      'i am stuck',
      'i need help',
    ],
    answer: `Try VECTRA first — describe what you were doing and what failed. If VECTRA can't resolve it:

1. For workflow questions: ask your team lead
2. For access / permission issues: ask your admin
3. For technical problems (page errors, missing data): escalate to Super Admin

Include a screenshot and the exact error text when you escalate — it saves a round trip.`,
  },
  {
    audience: 'STAFF',
    targetRoles: [...ALL_STAFF_ROLES, ...UNRESTRICTED_BUCKET],
    variants: [
      'what does the sidebar mean',
      'sidebar badges',
      'what are the numbers on sidebar',
      'sidebar counts',
      'badge counts',
    ],
    answer: `The numbers on sidebar items are **badge counts** — items waiting for you to act on. For example, an ISR sees the count of pending calls, a BDM sees leads pending qualification, Docs team sees documents pending verification. Counts update live via a socket connection; if you see a number go up while you're browsing, it means new work just arrived. Click the sidebar item to see the list.`,
  },
  {
    audience: 'STAFF',
    targetRoles: [...ALL_STAFF_ROLES, ...UNRESTRICTED_BUCKET],
    variants: [
      'what can vectra do',
      'what can vectra help with',
      'what is vectra',
      'how to use vectra',
      'what is the chatbot',
    ],
    answer: `VECTRA is your onboarding assistant. Ask it "how do I..." or "what is..." questions about the CRM and you'll get step-by-step answers tailored to your role. Most common questions are answered instantly from a pre-built knowledge base — free and unlimited. Only truly novel questions call the AI model, and those are rate-limited per day. VECTRA doesn't take actions on your behalf; it explains and guides.`,
  },
  {
    audience: 'STAFF',
    targetRoles: [...ALL_STAFF_ROLES, ...UNRESTRICTED_BUCKET],
    variants: [
      'i see access denied',
      'why am i getting access denied',
      'access denied error',
      'permission error',
      'why can t i see this page',
    ],
    answer: `"Access denied" means your role doesn't have permission to see that page. Role permissions are intentional — only specific teams can access specific workflows (e.g., only NOC can configure a customer account, only Accounts can edit financial details). If you need access, contact your admin to confirm whether your role should be changed or if you need an exception.`,
  },
  {
    audience: 'STAFF',
    targetRoles: [...ALL_STAFF_ROLES, ...UNRESTRICTED_BUCKET],
    variants: [
      'what is otc and mrc',
      'what does otc mean',
      'what does mrc mean',
      'difference between otc and mrc',
      'explain otc mrc',
    ],
    answer: `**OTC** = One-Time Charge. Charged once at the start — installation fee, router/hardware cost, setup fees. Generates a separate OTC invoice.

**MRC** = Monthly Recurring Charge. The plan fee billed on the customer's billing cycle (monthly / quarterly / half-yearly / annual). Auto-generated by the system at 1 AM daily when a new cycle is due.

Both are set during quotation by the BDM and approved by the Sales Director before the customer is onboarded.`,
  },

  // ═══════════════════════════════════════════════════════════════════════
  // BDM
  // ═══════════════════════════════════════════════════════════════════════
  {
    audience: 'STAFF',
    targetRoles: ['BDM', 'BDM_CP', 'BDM_TEAM_LEADER', ...UNRESTRICTED_BUCKET],
    variants: [
      'what is the lead flow',
      'how does the lead flow work',
      'explain lead flow',
      'lead flow',
      'lead lifecycle',
      'how does a lead move',
      'full lead process',
      'lead pipeline',
    ],
    answer: `As a BDM, a lead moves through these stages — you're the owner until it reaches Feasibility:

1. **Lead lands in your queue** — either ISR-converted or self-created via Create Opportunity
2. **Qualify** — call the customer, confirm requirement, set disposition (Qualified / Follow-up / Dropped)
3. **Push to Feasibility** — ensure address & requirement are complete, click Push
4. **Feasibility reviews** — approves with vendor + CAPEX/OPEX estimates, or rejects
5. **You add the Quotation** — set ARC (annual recurring), OTC (one-time), attach quote PDF
6. **Submit for approval** — OPS auto-approves, then Sales Director approves
7. **Share approved quote with customer** (offline/email), collect signed docs
8. **Docs → Accounts → GST verified** — each team signs off
9. **Pushed to Installation** → NOC creates customer account, Delivery ships hardware, plan activates

You can track the current stage on the lead detail page.`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['BDM', 'BDM_CP', 'BDM_TEAM_LEADER', ...UNRESTRICTED_BUCKET],
    variants: [
      'how do i qualify a lead',
      'how to qualify lead',
      'lead qualification',
      'how to mark a lead qualified',
      'bdm disposition',
    ],
    answer: `1. Open the lead from your BDM queue
2. Review contact details and campaign/ISR notes
3. Call the customer to confirm interest, budget, and service requirement
4. Click **Disposition** and pick:
   - **Qualified** — move to feasibility
   - **Follow-up** — set a date; you'll get a 1-hour-before reminder
   - **Dropped** — add a reason; closes the lead
5. Add notes explaining the outcome

Only leads dispositioned as Qualified move forward. Make sure location + bandwidth requirement are captured before pushing to feasibility.`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['BDM', 'BDM_CP', 'BDM_TEAM_LEADER', ...UNRESTRICTED_BUCKET],
    variants: [
      'how to create an opportunity',
      'how do i create opportunity',
      'create opportunity',
      'add direct lead',
      'create new lead',
      'add a lead from scratch',
    ],
    answer: `Use **Create Opportunity** when a BDM-sourced lead comes in without an ISR call. Steps:

1. Top nav → **New → Create Opportunity**
2. Fill contact info (name, company, phone, email, industry)
3. Fill location (lat/long + full address) — required for feasibility
4. Pick a Feasibility team member
5. Fill requirement (bandwidth, number of IPs, interest level)
6. Optionally add tentative price / OTC / expected delivery date
7. Submit

The lead skips the ISR calling stage and lands directly in your assigned Feasibility team member's queue. A synthetic "[BDM Self Lead]" campaign is auto-created so the audit trail is intact.`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['BDM', 'BDM_CP', 'BDM_TEAM_LEADER', ...UNRESTRICTED_BUCKET],
    variants: [
      'how to push to feasibility',
      'push lead to feasibility',
      'send to feasibility team',
      'move lead to feasibility',
    ],
    answer: `1. Open the qualified lead
2. Ensure full address, location coordinates, bandwidth requirement, and primary contact phone are filled
3. Click **Push to Feasibility**, pick a Feasibility team member
4. The lead moves out of your queue into theirs; that user gets a notification

If fields are missing, the system blocks the push until they're filled. You can still track the lead on your Leads page after pushing — status updates live.`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['BDM', 'BDM_CP', 'BDM_TEAM_LEADER', ...UNRESTRICTED_BUCKET],
    variants: [
      'how do i submit a quote',
      'how to submit quote',
      'submit quotation for approval',
      'create quote',
      'how to create quotation',
      'submit for sales director approval',
    ],
    answer: `1. Open the lead after feasibility is **Approved**
2. Click **Create Quote** (or **Add Quotation**)
3. Fill ARC (annual recurring charge), OTC (one-time charge), bandwidth, billing cycle
4. Upload the quotation PDF/image
5. Click **Submit for Approval**

What happens next: OPS auto-approves immediately, the quote goes to the Sales Director for final approval. You'll get a notification when they approve or reject. If rejected, fix the quote based on their reason and resubmit.

Only **approved** quotes move to document collection and billing setup.`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['BDM', 'BDM_CP', 'BDM_TEAM_LEADER', ...UNRESTRICTED_BUCKET],
    variants: [
      'how do follow ups work',
      'how to schedule follow up',
      'follow up reminder',
      'set follow up',
      'callback',
    ],
    answer: `When you disposition a lead as **Follow-up**, pick a date + time. One hour before that time you'll get an in-app notification. Missed follow-ups (past due) are highlighted in red on the **Follow-Ups** sidebar page and show on your team leader's dashboard too, so don't let them pile up.`,
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ISR
  // ═══════════════════════════════════════════════════════════════════════
  {
    audience: 'STAFF',
    targetRoles: ['ISR', ...UNRESTRICTED_BUCKET],
    variants: [
      'how do i start a call',
      'how to start call',
      'start calling',
      'calling flow',
      'how to make calls',
      'isr calling',
    ],
    answer: `1. Open **Calling Queue** from the sidebar — these are contacts assigned to you from your campaigns
2. Click a contact to open the record
3. Click **Start Call** — this logs the start time
4. Have the conversation
5. Click **End Call** and pick a **disposition**:
   - **Interested** → you'll collect more details and convert to a lead
   - **Call Later** → set a date/time; contact goes to Retry Queue
   - **Not Interested** → closes the contact
   - **Do Not Call** → permanently DNC'd, no one can call this number again
6. Add notes
7. If Interested, click **Convert to Lead** — fills in extra info and moves the record to a BDM's queue`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['ISR', ...UNRESTRICTED_BUCKET],
    variants: [
      'how to convert to lead',
      'convert contact to lead',
      'lead conversion',
      'how do i convert',
      'how to qualify a contact',
    ],
    answer: `1. While on a call dispositioned as **Interested**, click **Convert to Lead**
2. Fill in:
   - Company / contact / title
   - Requirement (bandwidth, number of IPs)
   - Preferred plan
   - Rough location
3. Pick a BDM from the dropdown (or accept the auto-suggested one based on region)
4. Submit

The contact moves out of your calling queue and becomes a qualified lead. The assigned BDM gets a notification and sees it in their queue.`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['ISR', ...UNRESTRICTED_BUCKET],
    variants: [
      'what does dnc mean',
      'do not call',
      'how to mark dnc',
      'mark as do not call',
    ],
    answer: `DNC = Do Not Call. If the contact explicitly asks never to be called again, disposition the call as **Do Not Call**. This flags the number permanently — nobody on the team can call it again from this CRM, and it's excluded from future campaign imports. DNC is serious; only use it when the customer really means it, because it can't be reversed without admin intervention.`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['ISR', ...UNRESTRICTED_BUCKET],
    variants: [
      'what are isr dashboard metrics',
      'isr dashboard',
      'what do the numbers on my dashboard mean',
      'isr kpis',
    ],
    answer: `**Calls Today** — completed calls in the last 24h
**Pending Queue** — contacts you haven't called yet
**Follow-Ups Due** — scheduled callbacks due in the next hour + overdue ones
**Converted** — leads you created (drives your pipeline contribution)
**Connect Rate** — % of attempted calls that actually connected

Aim for a high connect rate and zero overdue follow-ups — that's how team leaders measure ISR productivity.`,
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ACCOUNTS TEAM
  // ═══════════════════════════════════════════════════════════════════════
  {
    audience: 'STAFF',
    targetRoles: ['ACCOUNTS_TEAM', ...UNRESTRICTED_BUCKET],
    variants: [
      'how do i generate an invoice',
      'how to generate invoice',
      'create invoice',
      'manually generate invoice',
      'how to make invoice',
    ],
    answer: `Invoices are auto-generated daily at 1 AM for every active plan whose cycle is due. To create one manually:

1. Open the customer (Customer 360 or the lead page)
2. Click **Invoices → Generate Invoice**
3. Select billing period, plan, and any adjustments (discount, pro-ration)
4. Review GST — **9% SGST + 9% CGST = 18%** by default
5. Click **Generate**

Invoice number format: **GLL/DD/MM/YY-XXXX**. The customer gets an email + sees it in their portal.`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['ACCOUNTS_TEAM', ...UNRESTRICTED_BUCKET],
    variants: [
      'how do i record a payment',
      'how to record payment',
      'add payment',
      'mark invoice paid',
      'how to mark payment',
    ],
    answer: `1. Open the invoice
2. Click **Add Payment**
3. Fill: amount, payment mode (Cheque / NEFT / Online / TDS), reference number, payment date
4. Upload payment proof if you have a screenshot
5. Submit

The invoice status updates automatically (Partially Paid / Paid), the ledger gets a new credit entry, and a receipt number is generated. For a lump-sum payment covering multiple invoices, use **Bulk Pay** instead.`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['ACCOUNTS_TEAM', ...UNRESTRICTED_BUCKET],
    variants: [
      'what is the customer ledger',
      'how does ledger work',
      'ledger entries',
      'customer ledger',
      'view ledger',
    ],
    answer: `The customer ledger is the **single source of truth** for financial transactions. It's append-only — entries are never edited or deleted, only offset by new entries. You'll see:

- **INVOICE** — debit (customer owes more)
- **PAYMENT** — credit (owed less)
- **CREDIT_NOTE** — credit
- **REFUND** — debit

The running balance shows exactly what the customer owes right now. Open the customer → **Ledger** tab.`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['ACCOUNTS_TEAM', ...UNRESTRICTED_BUCKET],
    variants: [
      'how to create credit note',
      'credit note process',
      'issue credit note',
      'refund through credit note',
    ],
    answer: `1. Open the invoice that needs offsetting
2. Click **Create Credit Note**
3. Pick a reason: Service Downtime / Overpayment / Price Adjustment / Cancellation / Error Correction / Plan Downgrade
4. Enter the credit amount (full or partial) + notes
5. Submit

A CN number is generated (**CN/DD/MM/YY-XXXX**), the ledger gets a credit entry, and the invoice's remaining balance decreases. Credit notes go through an approval chain before they're finalized.`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['ACCOUNTS_TEAM', ...UNRESTRICTED_BUCKET],
    variants: [
      'what is advance payment',
      'how to record advance payment',
      'advance payment flow',
      'pre invoice payment',
    ],
    answer: `Advance payments are collected **before** an invoice exists — typical for OTC (installation fee) or prepayment. To record:

1. Open the customer → **Advance Payments → Record Advance**
2. Enter amount, mode, reference number
3. Submit

The advance sits on the customer's account as a credit balance and **auto-applies** against future invoices until exhausted. You can see current advance balance on the customer's billing tab.`,
  },

  // ═══════════════════════════════════════════════════════════════════════
  // DOCS TEAM
  // ═══════════════════════════════════════════════════════════════════════
  {
    audience: 'STAFF',
    targetRoles: ['DOCS_TEAM', ...UNRESTRICTED_BUCKET],
    variants: [
      'what documents are required',
      'which documents do i need',
      'required documents',
      'mandatory docs',
      'document list',
    ],
    answer: `Standard required documents for every customer:

- **PAN card** — mandatory
- **GST certificate** — for business customers
- **Address proof** — electricity bill / rental agreement / property tax receipt
- **Authorized signatory ID** — usually Aadhaar or passport
- **Bank details / cancelled cheque** — for auto-debit

The Accounts team may request additional docs based on customer category. All documents must be legible; reject illegible uploads with a clear reason.`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['DOCS_TEAM', ...UNRESTRICTED_BUCKET],
    variants: [
      'how do i verify documents',
      'how to verify doc',
      'document verification',
      'approve document',
      'reject document',
    ],
    answer: `1. Open the lead → **Documents** tab
2. For each uploaded doc, click **Preview** to see the file
3. Cross-check the name, company, and document numbers against the lead record
4. Click **Approve** or **Reject**
5. On **Reject** — add a clear reason; the BDM + customer get notified so they can re-upload

Once **all required docs** are approved, the lead advances automatically to Accounts Verification. You can't push it forward if any required doc is pending.`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['DOCS_TEAM', ...UNRESTRICTED_BUCKET],
    variants: [
      'how to generate upload link',
      'customer document upload link',
      'send upload link',
      'request customer to upload',
    ],
    answer: `When a customer needs to upload docs themselves:

1. On the lead page, click **Generate Upload Link**
2. Pick the document types you need
3. The system creates a secure token-based link (valid 7 days)
4. Share via email/WhatsApp
5. Customer clicks → uploads → you get notified

Links expire after 7 days. If the customer says the link is expired, just generate a new one — old links remain in the audit log.`,
  },

  // ═══════════════════════════════════════════════════════════════════════
  // FEASIBILITY TEAM
  // ═══════════════════════════════════════════════════════════════════════
  {
    audience: 'STAFF',
    targetRoles: ['FEASIBILITY_TEAM', ...UNRESTRICTED_BUCKET],
    variants: [
      'how do i review feasibility',
      'feasibility review',
      'how to mark feasible',
      'feasibility disposition',
      'approve feasibility',
    ],
    answer: `1. Open the lead from your Feasibility queue
2. Review the customer address + bandwidth requirement
3. Cross-check coverage, nearest POP, and vendor availability
4. Click **Feasibility Disposition**:
   - **Feasible** → pick vendor type (ownNetwork / fiberVendor / commissionVendor / thirdParty / telco) + enter tentative CAPEX & OPEX
   - **Not Feasible** → add reason

On Feasible, the lead moves to the BDM's Quotation step. On Not Feasible, the lead closes with your reason logged on the journey.`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['FEASIBILITY_TEAM', ...UNRESTRICTED_BUCKET],
    variants: [
      'what is tentative capex',
      'what does capex opex mean',
      'capex opex in feasibility',
      'feasibility cost estimate',
    ],
    answer: `- **CAPEX** (Capital Expenditure) — one-time cost to light up the connection: fiber, switches, hardware
- **OPEX** (Operating Expenditure) — monthly recurring vendor/infra cost

Your estimate is **tentative** — the Delivery team replaces it with **actual** figures during vendor setup after the quote is approved. Customer 360 shows both side-by-side so leadership can see estimate-vs-actual variance.`,
  },

  // ═══════════════════════════════════════════════════════════════════════
  // NOC TEAM
  // ═══════════════════════════════════════════════════════════════════════
  {
    audience: 'STAFF',
    targetRoles: ['NOC_TEAM', 'NOC', 'NOC_HEAD', ...UNRESTRICTED_BUCKET],
    variants: [
      'how to create customer account',
      'create customer',
      'noc flow',
      'noc configuration',
      'how do i configure customer',
    ],
    answer: `After Ops approval, the lead lands in your NOC queue. Steps:

1. Open the lead
2. Click **Create Customer Account**
3. Assign: **username**, password, IP address (static or dynamic), circuit ID
4. Save — the customer can now log in to the portal

Next steps (same lead page):
- **Assign Demo Plan** — temporary trial before actual plan
- Coordinate with Delivery team for hardware installation
- Run **Speed Test** → upload screenshot
- Mark **Customer Acceptance** once customer confirms
- Click **Activate Actual Plan** — invoicing begins on next billing cycle`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['NOC_TEAM', 'NOC', 'NOC_HEAD', ...UNRESTRICTED_BUCKET],
    variants: [
      'how to activate demo plan',
      'assign demo plan',
      'demo plan setup',
      'what is demo plan',
    ],
    answer: `The demo plan is a temporary trial plan the customer uses while the actual plan is being finalized. To assign:

1. Open the lead (after customer account is created)
2. Click **Assign Demo Plan**
3. Pick bandwidth, validity (days), and data limit
4. Confirm

The demo plan is active immediately. It auto-expires on the validity date — the system will alert you before expiry so you can activate the actual plan.`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['NOC_TEAM', 'NOC', 'NOC_HEAD', ...UNRESTRICTED_BUCKET],
    variants: [
      'how to activate actual plan',
      'activate paid plan',
      'actual plan activation',
      'switch to paid plan',
    ],
    answer: `After speed test passes and customer signs acceptance:

1. Open the lead
2. Click **Activate Actual Plan**
3. Confirm plan name, MRC, start date, end date (based on billing cycle)
4. Submit

The demo plan is deactivated and the actual plan goes live. The daily 1 AM invoice job will generate the first invoice on the next billing cycle boundary. The customer can now use service per the agreed plan.`,
  },

  // ═══════════════════════════════════════════════════════════════════════
  // DELIVERY TEAM
  // ═══════════════════════════════════════════════════════════════════════
  {
    audience: 'STAFF',
    targetRoles: ['DELIVERY_TEAM', ...UNRESTRICTED_BUCKET],
    variants: [
      'what is the delivery flow',
      'delivery process',
      'how does delivery work',
      'material delivery flow',
    ],
    answer: `Delivery kicks in after Ops approval + customer account creation. Flow:

1. **Vendor setup** — you pick the delivery vendor + enter actual CAPEX/OPEX (replacing feasibility's tentative numbers)
2. **Create Delivery Request** — specify items needed (fiber, switches, etc.)
3. **Approval chain** — Super Admin approves → Area Head approves
4. **Store assignment** — Store Manager picks materials and assigns serial numbers
5. **Dispatch** — materials leave the store
6. **Install** — at customer site
7. **Complete** — you mark the delivery done; NOC takes over for speed test & plan activation`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['DELIVERY_TEAM', ...UNRESTRICTED_BUCKET],
    variants: [
      'how to setup delivery vendor',
      'vendor setup delivery',
      'how do i setup vendor',
      'delivery vendor configuration',
    ],
    answer: `Vendor setup is mandatory **before** creating a delivery request. Steps:

1. Open the lead
2. Click **Delivery Vendor Setup**
3. Pick vendor from the approved list (filtered by feasibility's vendor type)
4. Enter fiber required (meters), per-meter cost, any other infra costs
5. Enter actual CAPEX + actual OPEX
6. Add vendor notes if needed
7. Submit

The actual numbers show on Customer 360 side-by-side with feasibility's tentative estimates — leadership uses this for variance analysis.`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['DELIVERY_TEAM', ...UNRESTRICTED_BUCKET],
    variants: [
      'how to create delivery request',
      'create material request',
      'material request',
      'request items for delivery',
    ],
    answer: `1. Open the lead (vendor setup must be done first)
2. Click **Create Delivery Request**
3. Add line items — product, quantity per product
4. Submit

The request gets a number (DR-XXXX) and enters the approval chain: Super Admin → Area Head → Store Manager. You'll see the status on the request detail page and get notifications as it moves forward.`,
  },

  // ═══════════════════════════════════════════════════════════════════════
  // SAM EXECUTIVE
  // ═══════════════════════════════════════════════════════════════════════
  {
    audience: 'STAFF',
    targetRoles: ['SAM_EXECUTIVE', 'SAM', ...UNRESTRICTED_BUCKET],
    variants: [
      'what is sam',
      'sam role',
      'service account manager',
      'what does a sam do',
    ],
    answer: `A SAM (Service Account Manager) owns the post-sale customer relationship. Once a customer is activated, they're assigned to a SAM. Your job:

- **Nurture** — regular check-ins, meetings, visits
- **Upsell/renew** — propose upgrades, watch contract expiry dates
- **Resolve complaints** — coordinate with Support team on issues
- **Manage disconnections** — handle service orders when customers leave

You see your assigned customers in the **SAM Queue**. Customer 360 is your primary tool.`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['SAM_EXECUTIVE', 'SAM', ...UNRESTRICTED_BUCKET],
    variants: [
      'how to schedule meeting',
      'sam meeting',
      'schedule customer meeting',
      'how to log meeting',
    ],
    answer: `1. Open the customer
2. Click **Schedule Meeting**
3. Pick type (Review / Escalation / Sales / Renewal), date + time, participants
4. Save — it shows on your calendar view
5. After the meeting, click **Log Minutes** on that meeting entry to record outcomes + next steps

Meetings show on Customer 360's journey so future SAMs can see relationship history.`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['SAM_EXECUTIVE', 'SAM', ...UNRESTRICTED_BUCKET],
    variants: [
      'how to create service order',
      'upgrade downgrade customer plan',
      'service order flow',
      'plan change',
      'disconnection',
    ],
    answer: `Service orders change the customer's plan post-sale. Types: **Upgrade / Downgrade / Rate Revision / Disconnection**.

1. Customer page → **Service Orders → Create**
2. Pick type + new plan + effective date
3. Add reason + any supporting docs
4. Submit

The order goes through approvals (SAM Head for value changes, then Accounts, then NOC for activation). Pro-rated billing applies automatically when the plan changes mid-cycle.`,
  },

  // ═══════════════════════════════════════════════════════════════════════
  // STORE
  // ═══════════════════════════════════════════════════════════════════════
  {
    audience: 'STAFF',
    targetRoles: ['STORE_MANAGER', 'STORE_ADMIN', ...UNRESTRICTED_BUCKET],
    variants: [
      'how to create purchase order',
      'create po',
      'store purchase order',
      'raise po',
    ],
    answer: `1. Store → **Purchase Orders → New PO**
2. Select vendor
3. Add line items: product, quantity, unit price, GST rate
4. Review total
5. Submit

The PO enters the approval chain (Store Manager → Admin). Once fully approved, you can receive goods against it. PO number format: **PO/DD/MM/YY-XXXX**.`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['STORE_MANAGER', 'STORE_ADMIN', ...UNRESTRICTED_BUCKET],
    variants: [
      'how to receive goods',
      'goods receipt',
      'grn',
      'receive materials',
      'how to add items to inventory',
    ],
    answer: `1. Open the approved PO
2. Click **Receive Goods**
3. Enter actual quantity received per item (can be partial)
4. For serialized items, scan or manually enter each serial number — each serial is tracked individually
5. Submit — a GRN is logged, stock is added to inventory

If there's a mismatch with the PO quantity, flag it to the admin; don't silently close it.`,
  },

  // ═══════════════════════════════════════════════════════════════════════
  // SUPPORT / COMPLAINTS
  // ═══════════════════════════════════════════════════════════════════════
  {
    audience: 'STAFF',
    targetRoles: ['SUPPORT_TEAM', ...UNRESTRICTED_BUCKET],
    variants: [
      'how to create complaint',
      'log complaint',
      'new complaint',
      'complaint flow',
      'how to file complaint',
    ],
    answer: `1. Sidebar → **Complaints → New Complaint**
2. Search the customer by name, phone, or customer username
3. Pick category → subcategory (TAT auto-fills)
4. Set priority: Low / Medium / High / Critical
5. Add description
6. Submit

Complaint number format: **CMP/DD/MM/YY-XXXX**. Assign it to a team/user immediately so the TAT clock starts counting down.`,
  },
  {
    audience: 'STAFF',
    targetRoles: ['SUPPORT_TEAM', ...UNRESTRICTED_BUCKET],
    variants: [
      'how to close complaint',
      'close complaint',
      'resolve complaint',
      'complaint closure',
    ],
    answer: `1. Open the complaint
2. Click **Close Complaint**
3. Fill: **Reason for Outage** + **Resolution** + **Resolution Type** (dropdown values)
4. Add closing notes (what was done)
5. Submit

The customer is notified; the complaint status flips to CLOSED. If TAT was breached, that's recorded in the complaint's audit trail. You can't close a complaint without all three close fields filled.`,
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CUSTOMER PORTAL
  // ═══════════════════════════════════════════════════════════════════════
  {
    audience: 'CUSTOMER',
    targetRoles: [], // customer audience ignores roles
    variants: [
      'how do i log in',
      'how to login',
      'customer portal login',
      'login',
      'how do i sign in',
    ],
    answer: `Use the **Customer Username** and password we shared with you during account setup. Go to the customer portal login page, enter both, and you'll land on your dashboard. Forgot your password? Contact our support team — they'll reset it for you. Your session lasts 7 days on a device before you'll be asked to log in again.`,
  },
  {
    audience: 'CUSTOMER',
    targetRoles: [],
    variants: [
      'how do i view my invoices',
      'see invoices',
      'download invoice',
      'my invoices',
      'where are my bills',
    ],
    answer: `Click **Invoices** in the sidebar. You'll see every invoice with status (Paid / Unpaid / Overdue / Partially Paid) and amount. Click any invoice to see detailed line items and tax breakdown, or click **Download PDF** to save a copy for your records. New invoices are posted automatically at the start of each billing cycle.`,
  },
  {
    audience: 'CUSTOMER',
    targetRoles: [],
    variants: [
      'how do i make a payment',
      'how to pay',
      'pay invoice',
      'online payment',
      'how to settle dues',
    ],
    answer: `Go to **Invoices → Unpaid → Pay Now** for the invoice you want to settle. Choose a payment method (online transfer / UPI / card — as available to you). After completing the transaction, share the transaction reference number with our Accounts team if the payment doesn't reflect automatically within 24 hours. Your payment history lives under **Payments** in the sidebar.`,
  },
  {
    audience: 'CUSTOMER',
    targetRoles: [],
    variants: [
      'how to file a complaint',
      'new complaint',
      'report issue',
      'raise ticket',
      'how to log complaint',
    ],
    answer: `Click **Complaints → New Complaint**. Pick a category (Service Down, Slow Speed, Billing Issue, etc.), describe the issue with as much detail as possible, and submit. You'll get a complaint ID (format: **CMP/DD/MM/YY-XXXX**). Our support team investigates and keeps you updated. You can check status any time from the **Complaints** page.`,
  },
  {
    audience: 'CUSTOMER',
    targetRoles: [],
    variants: [
      'how to see my plan',
      'my current plan',
      'what is my plan',
      'plan details',
      'subscription details',
    ],
    answer: `Click **My Plan** in the sidebar. You'll see:

- Current plan name + bandwidth
- Monthly charge (MRC)
- Billing cycle (monthly / quarterly / etc.)
- Plan start and next renewal dates
- Plan status (Active / Demo / Paused)

If you want to upgrade, downgrade, or disconnect, contact your account manager — they'll raise a service order for you.`,
  },
  {
    audience: 'CUSTOMER',
    targetRoles: [],
    variants: [
      'how to update my details',
      'change contact info',
      'update profile',
      'edit my information',
    ],
    answer: `View your profile under **My Details** in the sidebar. To update contact information, email address, or billing address, use the **Enquiries** section to raise a request — your account manager will verify the change (for security) and apply it on your behalf. For immediate changes, contact support directly.`,
  },
];

// ─── Seeder function ─────────────────────────────────────────────────────

export async function seedNexusCache(prisma) {
  // Build the set of rows we want to install.
  const rows = [];
  for (const q of CACHED_QUESTIONS) {
    for (const rawVariant of q.variants) {
      const normalized = normalize(rawVariant);
      if (!normalized) continue;

      if (q.audience === 'CUSTOMER') {
        rows.push({
          normalizedQuery: `CUSTOMER|${normalized}`,
          audience: 'CUSTOMER',
          answer: q.answer,
          knowledgeIds: [SEED_MARKER],
          hitCount: 0,
        });
      } else {
        for (const role of q.targetRoles) {
          rows.push({
            normalizedQuery: `${role}|STAFF|${normalized}`,
            audience: 'STAFF',
            answer: q.answer,
            knowledgeIds: [SEED_MARKER],
            hitCount: 0,
          });
        }
      }
    }
  }

  // Deduplicate by normalizedQuery (unique key). Later wins.
  const byKey = new Map();
  for (const r of rows) byKey.set(r.normalizedQuery, r);
  const unique = Array.from(byKey.values());
  const keysToWrite = unique.map((r) => r.normalizedQuery);

  // Wipe:
  //  1. Any prior seeded rows (by marker) — catches rows from an older seed
  //     version whose question phrasings we've since removed.
  //  2. Any organic cache rows that happen to occupy one of the keys we're
  //     about to install — ensures our curated answer always wins over
  //     whatever a one-off Gemini or direct-match call stored earlier.
  const [deletedSeeded, deletedConflicting] = await prisma.$transaction([
    prisma.nexusCache.deleteMany({ where: { knowledgeIds: { has: SEED_MARKER } } }),
    prisma.nexusCache.deleteMany({ where: { normalizedQuery: { in: keysToWrite } } }),
  ]);

  if (unique.length) {
    await prisma.nexusCache.createMany({ data: unique });
  }

  console.log(
    `[seed] VECTRA cache pre-warmed: removed ${deletedSeeded.count} old seeded + ${deletedConflicting.count} organic-conflict rows, inserted ${unique.length} fresh rows (${CACHED_QUESTIONS.length} distinct questions)`,
  );
}
