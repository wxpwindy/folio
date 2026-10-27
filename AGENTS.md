<!-- BEGIN AWS Agent Toolkit rules -->
# AWS Guidance for the new AWS experience

This user has signed up for the new AWS experience. This experience lets you sign into AWS using a social provider and requires the following additional context.

Where this guidance conflicts with the project's own instructions, the project's instructions take precedence.

## Context

### Terminology:

- Say "project" instead of "account" — a project contains an AWS account and settings for sharing with other collaborators
- Say "team member" instead of "IAM user" — users are invited by email, not created or federated in IAM
- Say "AWS Settings" when referring to management tasks at [settings.aws.com](https://settings.aws.com/) (project management, billing, team members, spend limits). Users view their actual AWS resources in the AWS Management Console.
- Say "selected Region" when referring to the user's Region — not "home Region"
- The user has a managed IAM experience. This includes a managed service control policies (SCP) and resource control policies (RCP) that govern the use of AWS. They will still need to use IAM to create policies to let services work with each other. If there are questions about the SCPs or RCPs, go to the documentation at https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html

### Constraints:

- All projects share a single AWS Region determined by the user's contact address. Resources cannot be created in other Regions
- When developing:
  - MUST create all Regional resources in the project's assigned Region
  - You CAN create AWS WAF and Cloudwatch Logs resources in us-east-1 when there are global resources (like a global WAF instance) that require a connection to dependencies in us-east-1. You should not use these for any other reason, because resources in the selected Region will provide lower cost (due to no cross-Region traffic), increased availability (due to no cross-Region traffic), and easier manageability (due to not needing to look in another Region). When you need to do an inventory of resources, you need to look in both the selected Region and us-east-1 for Cloudwatch Logs or WAF resources.
  - MUST NOT attempt to create Lambda, API Gateway, or other Regional resources in any other Region
  - MUST direct users to confirm their Region in AWS Settings > View all projects > Overview > Additional Info > Region. If the user cannot confirm their Region, check in ~/.aws/config
  - MUST NOT use Lambda@Edge — excluded from both Lambda and CloudFront
  - MUST NOT use CloudFormation StackSets — no multi-account or multi-Region deployments
  - MUST NOT attempt cross-Region actions — no cross-Region replication for DynamoDB/S3/RDS, no multi-Region KMS keys
  - MUST NOT use Route 53 cross-Region routing — geolocation, latency-based, and failover routing policies are not available
  - CloudFront is a global service and its actions ARE allowed in `us-east-1`. A user can create a CloudFront distribution pointing to their project-region Lambda function URL or API Gateway. However, Lambda and API Gateway themselves MUST NOT be created in `us-east-1` — they must be in the project Region.
  - Reduced availability in `eu-north-1` specifically: Amazon Rekognition, Amazon Textract, Amazon Personalize, AWS App Runner are not available in that Region.
- IAM permissions for human access are managed by AWS. Don't assign roles to team members unless absolutely necessary
- The user may have a spend limit if they are on the paid plan. The limit that pauses their project if it's exceeded. If resources suddenly become inaccessible, ask if they have a spend limit configured. Only project owners can modify a spend limit.
- When developing:
  - MUST ask about spend limit status if the user reports sudden "Access Denied" errors on operations that previously worked
  - MUST direct users to check spend status in AWS Settings > Billing
  - MUST check if a user has upgraded their account to the paid plan
  - MUST ask the user if they want to clean up the successfully created resources or keep them to reduce cost
- The user sets up billing, creates spend limits, and retrieves and pays invoices in AWS Settings. The user creates budgets and optimizes their costs in the AWS Billing and Cost Management console
- Not all AWS services are available. If a service isn't working, do the following:
  1. Run the command `aws freetier get-account-plan-state`
  2. If accountPlanType": "FREE", check the [Free Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-free-tier) next,
  3. If accountPlanType": "PAID", check the [Paid Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-paid-plan).
  4. If neither list shows the service, check the [Not supported for this experience list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#unsupported-services). The user will need to activate advanced features to access this service.
- Users can activate advanced AWS services and capabilities for their account.
- Before starting a task, check whether a relevant AWS skill is available. Load the skill with retrieve_skill and prefer its guidance over general knowledge.

### Help level

- help_level (required): LOW, MEDIUM, or HIGH. While a user is building, you MUST ask the user: "How much guidance would you like from me? Low (I only flag security risks), medium (I ask a couple of clarifying questions if something seems off), or high (I explain what I'm doing, suggest alternatives, and flag best practices)."

You CAN update this rule file to save a user's help_level.

Constraints for each level:

**LOW:**

- MUST follow all constraints in this context file
- MUST execute the user’s request without modification
- MUST NOT ask clarifying questions unless the action would create a security vulnerability
- MUST NOT suggest alternatives or improvements

**MEDIUM:**

- MUST execute the user's request
- MAY ask up to two clarifying questions per task if the request has an ambiguity or a potential issue
- MUST NOT repeat a question or suggestion the user has already dismissed
- MUST NOT explain trade-offs or alternatives unless the user asks

**HIGH:**

- MUST explain what each step does and why before executing it
- MUST suggest alternatives when a better approach exists
- MUST flag best practices and explain trade-offs
- MUST still execute the user's choice if they disagree with a suggestion
<!-- END AWS Agent Toolkit rules -->

## Folio Agent Guidance

Use this section for project-specific behavior. Keep detailed product behavior in [README.md](README.md) and test-isolation details in [tests/README.md](tests/README.md).

### Project Basics

- Stack: TypeScript, React (frontend), Express (backend), SQLite store.
- Runtime: Node.js 24+ (see [package.json](package.json)).
- Local-only design: loopback host/origin protections are intentional and should not be relaxed.

### Commands Agents Should Prefer

- Install: `npm install`
- Dev: `npm run dev`
- Build: `npm run build`
- Production local run: `npm start`
- Backend tests: `npm test`
- Browser tests: `npm run test:e2e`
- Lint: `npm run lint`

### Code Boundaries

- Backend entrypoint: [server/index.ts](server/index.ts)
- API composition and route guards: [server/app.ts](server/app.ts)
- Frontend entrypoint: [src/main.tsx](src/main.tsx)
- Frontend API client and request headers: [src/api.ts](src/api.ts)
- E2E fixture server and deterministic fake providers: [tests/fixture-server.ts](tests/fixture-server.ts)

### Conventions For Safe Changes

- Preserve mutation/header/session protections; do not bypass auth checks in app code.
- Add or update backend tests in [server](server) for server behavior changes.
- Add or update Playwright coverage in [tests](tests) for user-visible regressions.
- Do not introduce live external-network dependencies into E2E tests.

### Custom Agent Routing

- Use [.github/agents/backend-expert.agent.md](.github/agents/backend-expert.agent.md) for production backend implementation/review in Express/TypeScript (API routes, auth/session flows, backend security hardening, incident diagnostics, backend performance/reliability).
- Use [.github/agents/system-expert.agent.md](.github/agents/system-expert.agent.md) for system-level operations work: web security hardening, Core Web Vitals/TTFB optimization, caching strategy, uptime/fault-tolerance design, and production incident triage with severity-based remediation.
- For major infrastructure or edge changes (proxy, TLS termination, CDN, cloud edge), ask up to two clarifying questions before implementation.

### Security, Performance, and Reliability Review Mode

When a user asks for security review, production hardening, or incident diagnosis, agents should:

- Prioritize security and stability over speed of implementation.
- Evaluate changes against OWASP Top 10 risks (especially broken access control, injection, XSS, and CSRF-like cross-origin abuse).
- Preserve and strengthen loopback-only Host/Origin and mutation-header defenses; do not relax them unless explicitly requested and risk-reviewed.
- Review response headers and cookie/session handling before approving auth, upload, or admin changes.
- Classify issues with explicit severity: `Critical`, `High`, `Medium`, `Low`.
- Provide exact fixes with file-level implementation guidance, not generic advice.
- For performance work, quantify likely impact on TTFB/Core Web Vitals and prefer measurable changes (query efficiency, cache behavior, payload size, compression).
- For reliability work, favor graceful degradation, timeouts, retries with bounds, and clear recovery/rollback procedures.
- Ask up to two clarifying questions before major infrastructure/config changes (for example reverse proxy, TLS termination, CDN, or cloud edge behavior).
- Validate fixes with the smallest relevant automated tests (`npm test`, `npm run test:e2e`, `npm run lint`) and report any remaining risk.
