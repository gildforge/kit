// Generated from the site's route handlers: path pattern → module.
import * as r0 from './api/account/invitations/[[...ids]].js'
import * as r1 from './api/account/orgs/[org].js'
import * as r2 from './api/account/picture.js'
import * as r3 from './api/account/profile.js'
import * as r4 from './api/account/tokens/[id].js'
import * as r5 from './api/account/tokens.js'
import * as r6 from './api/agents/[label].js'
import * as r7 from './api/agents/requests/[id].js'
import * as r8 from './api/agents/requests/[id]/token.js'
import * as r9 from './api/agents/requests.js'
import * as r10 from './api/agents.js'
import * as r11 from './api/auth/answer.js'
import * as r12 from './api/auth/challenge.js'
import * as r13 from './api/auth/signout.js'
import * as r14 from './api/auth/status.js'
import * as r15 from './api/claim/answer.js'
import * as r16 from './api/claim/prepare.js'
import * as r17 from './api/claim/status.js'
import * as r18 from './api/import.js'
import * as r19 from './api/orgs/[name]/[operation].js'
import * as r20 from './api/orgs/[name]/hooks/[[...hookpath]].js'
import * as r21 from './api/orgs/[name]/members.js'
import * as r22 from './api/orgs/[name]/memberships/[member].js'
import * as r23 from './api/orgs/[name].js'
import * as r24 from './api/orgs.js'
import * as r25 from './api/repos/[owner]/[repo]/[operation].js'
import * as r26 from './api/repos/[owner]/[repo]/actions/[[...path]].js'
import * as r27 from './api/repos/[owner]/[repo]/agent-package.js'
import * as r28 from './api/repos/[owner]/[repo]/agents/[sponsor]/[label]/[action].js'
import * as r29 from './api/repos/[owner]/[repo]/agents.js'
import * as r30 from './api/repos/[owner]/[repo]/collaborators/[[...names]].js'
import * as r31 from './api/repos/[owner]/[repo]/contents/[...path].js'
import * as r32 from './api/repos/[owner]/[repo]/hooks/[[...hookpath]].js'
import * as r33 from './api/repos/[owner]/[repo]/import/[[...operation]].js'
import * as r34 from './api/repos/[owner]/[repo]/islands.js'
import * as r35 from './api/repos/[owner]/[repo]/issues/[number]/comments.js'
import * as r36 from './api/repos/[owner]/[repo]/issues/[number].js'
import * as r37 from './api/repos/[owner]/[repo]/issues.js'
import * as r38 from './api/repos/[owner]/[repo]/orchestrators/[[...agent]].js'
import * as r39 from './api/repos/[owner]/[repo]/pulls/[number]/comments.js'
import * as r40 from './api/repos/[owner]/[repo]/pulls/[number]/diff.js'
import * as r41 from './api/repos/[owner]/[repo]/pulls/[number]/reviews.js'
import * as r42 from './api/repos/[owner]/[repo]/pulls/[number].js'
import * as r43 from './api/repos/[owner]/[repo]/pulls.js'
import * as r44 from './api/repos/[owner]/[repo].js'
import * as r45 from './api/repos/[owner]/[repo]/search.js'
import * as r46 from './api/repos/[owner]/[repo]/tree.js'
import * as r47 from './api/repos/[owner]/[repo]/visibility.js'
import * as r48 from './api/repos.js'
import * as r49 from './api/runner-settings/[[...path]].js'
import * as r50 from './api/search.js'
import * as r51 from './api/tokens.js'
import * as r52 from './api/user/starred/[owner]/[repo].js'
import * as r53 from './api/v1/[[...path]].js'
import * as r54 from './git/[owner]/[repo]/[...path].js'

export const ROUTES: { path: string; methods: string[]; handler: Record<string, unknown> }[] = [
  { path: '/api/account/invitations/[[...ids]]', methods: ["GET", "PATCH", "DELETE"], handler: r0 },
  { path: '/api/account/orgs/[org]', methods: ["DELETE"], handler: r1 },
  { path: '/api/account/picture', methods: ["PUT","DELETE"], handler: r2 },
  { path: '/api/account/profile', methods: ["GET","PATCH"], handler: r3 },
  { path: '/api/account/tokens/[id]', methods: ["DELETE"], handler: r4 },
  { path: '/api/account/tokens', methods: ["GET","POST"], handler: r5 },
  { path: '/api/agents/[label]', methods: ["DELETE","POST"], handler: r6 },
  { path: '/api/agents/requests/[id]', methods: ["GET","POST"], handler: r7 },
  { path: '/api/agents/requests/[id]/token', methods: ["POST"], handler: r8 },
  { path: '/api/agents/requests', methods: ["POST","GET"], handler: r9 },
  { path: '/api/agents', methods: ["GET"], handler: r10 },
  { path: '/api/auth/answer', methods: ["POST"], handler: r11 },
  { path: '/api/auth/challenge', methods: ["POST"], handler: r12 },
  { path: '/api/auth/signout', methods: ["POST"], handler: r13 },
  { path: '/api/auth/status', methods: ["GET"], handler: r14 },
  { path: '/api/claim/answer', methods: ["POST"], handler: r15 },
  { path: '/api/claim/prepare', methods: ["POST"], handler: r16 },
  { path: '/api/claim/status', methods: ["GET"], handler: r17 },
  { path: '/api/import', methods: ["POST"], handler: r18 },
  { path: '/api/orgs/[name]/[operation]', methods: ["GET","PATCH","PUT","POST","DELETE"], handler: r19 },
  { path: '/api/orgs/[name]/hooks/[[...hookpath]]', methods: ["GET","POST","PATCH","DELETE"], handler: r20 },
  { path: '/api/orgs/[name]/members', methods: ["POST"], handler: r21 },
  { path: '/api/orgs/[name]/memberships/[member]', methods: ["PUT","DELETE"], handler: r22 },
  { path: '/api/orgs/[name]', methods: ["GET","DELETE"], handler: r23 },
  { path: '/api/orgs', methods: ["GET","POST"], handler: r24 },
  { path: '/api/repos/[owner]/[repo]/[operation]', methods: ["POST","PUT","GET"], handler: r25 },
  { path: '/api/repos/[owner]/[repo]/actions/[[...path]]', methods: ["GET","POST","PUT","DELETE"], handler: r26 },
  { path: '/api/repos/[owner]/[repo]/agent-package', methods: ["PUT"], handler: r27 },
  { path: '/api/repos/[owner]/[repo]/agents/[sponsor]/[label]/[action]', methods: ["POST"], handler: r28 },
  { path: '/api/repos/[owner]/[repo]/agents', methods: ["GET","POST"], handler: r29 },
  { path: '/api/repos/[owner]/[repo]/collaborators/[[...names]]', methods: ["GET", "PUT", "DELETE"], handler: r30 },
  { path: '/api/repos/[owner]/[repo]/contents/[...path]', methods: ["GET"], handler: r31 },
  { path: '/api/repos/[owner]/[repo]/hooks/[[...hookpath]]', methods: ["GET","POST","PATCH","DELETE"], handler: r32 },
  { path: '/api/repos/[owner]/[repo]/import/[[...operation]]', methods: ["GET","POST"], handler: r33 },
  { path: '/api/repos/[owner]/[repo]/islands', methods: ["GET"], handler: r34 },
  { path: '/api/repos/[owner]/[repo]/issues/[number]/comments', methods: ["GET","POST"], handler: r35 },
  { path: '/api/repos/[owner]/[repo]/issues/[number]', methods: ["GET","POST"], handler: r36 },
  { path: '/api/repos/[owner]/[repo]/issues', methods: ["GET","POST"], handler: r37 },
  { path: '/api/repos/[owner]/[repo]/orchestrators/[[...agent]]', methods: ["POST","DELETE"], handler: r38 },
  { path: '/api/repos/[owner]/[repo]/pulls/[number]/comments', methods: ["GET","POST"], handler: r39 },
  { path: '/api/repos/[owner]/[repo]/pulls/[number]/diff', methods: ["GET"], handler: r40 },
  { path: '/api/repos/[owner]/[repo]/pulls/[number]/reviews', methods: ["POST"], handler: r41 },
  { path: '/api/repos/[owner]/[repo]/pulls/[number]', methods: ["GET","POST"], handler: r42 },
  { path: '/api/repos/[owner]/[repo]/pulls', methods: ["GET","POST"], handler: r43 },
  { path: '/api/repos/[owner]/[repo]', methods: ["PATCH","DELETE"], handler: r44 },
  { path: '/api/repos/[owner]/[repo]/search', methods: ["GET"], handler: r45 },
  { path: '/api/repos/[owner]/[repo]/tree', methods: ["GET"], handler: r46 },
  { path: '/api/repos/[owner]/[repo]/visibility', methods: ["GET","PATCH"], handler: r47 },
  { path: '/api/repos', methods: ["GET","POST"], handler: r48 },
  { path: '/api/runner-settings/[[...path]]', methods: ["GET","POST","PATCH","PUT","DELETE"], handler: r49 },
  { path: '/api/search', methods: ["GET"], handler: r50 },
  { path: '/api/tokens', methods: ["POST"], handler: r51 },
  { path: '/api/user/starred/[owner]/[repo]', methods: ["PUT","DELETE"], handler: r52 },
  { path: '/api/v1/[[...path]]', methods: ["GET","POST","PATCH","PUT","DELETE"], handler: r53 },
  { path: '/git/[owner]/[repo]/[...path]', methods: ["GET","POST"], handler: r54 },
]
