import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditActions,
  bootstrap,
  configured,
  createProject,
  createTenant,
  createUser,
  login,
  type MssqlTestApp,
  type Session,
} from './harness.js';

/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
/** The first bytes of a WebP (RIFF....WEBP). */
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x1a, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
  Buffer.alloc(16),
]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16)]);
const SVG = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);

describe.skipIf(!configured)('SQL Server: the organisation’s colours and logo', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let other: { id: string; slug: string };
  let owner: Session;
  let interviewer: Session;
  let outsider: Session;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    other = await createTenant(t.owner);
    const project = await createProject(t.owner, tenant.id);
    owner = await login(t, await createUser(t.owner, tenant.id, [{ role: 'owner' }]), tenant.slug);
    interviewer = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'interviewer', projectId: project }]),
      tenant.slug,
    );
    outsider = await login(t, await createUser(t.owner, other.id, [{ role: 'owner' }]), other.slug);
  });
  afterAll(async () => {
    await t?.close();
  });

  const patch = (s: Session, body: unknown) =>
    s.agent
      .patch('/api/v1/tenant')
      .set('x-csrf-token', s.csrf)
      .send(body as object);
  const sendLogo = (s: Session, body: Buffer, name: string, alt?: string) => {
    const r = s.agent.put('/api/v1/tenant/logo').set('x-csrf-token', s.csrf);
    if (alt !== undefined) r.field('alt', alt);
    return r.attach('file', body, name);
  };

  it('saves a main colour, an accent, the side panel, the corners and where WanSurvey’s logo goes', async () => {
    const theme = {
      default: 'light',
      accent: 'brand',
      primary: '#7A1F5C',
      accentColor: '#FFD400',
      sidebar: { background: '#F4F6FC', text: '#20263A' },
      radius: 'round',
      appLogo: 'sub',
    };
    const res = await patch(owner, { branding: { theme } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Kept in lower case, and read by everyone of the organisation with their session.
    const kept = {
      ...theme,
      primary: '#7a1f5c',
      accentColor: '#ffd400',
      sidebar: { background: '#f4f6fc', text: '#20263a' },
    };
    expect(res.body.branding.theme).toEqual(kept);
    const me = await interviewer.agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.theme).toEqual(kept);
    expect(me.body.orgLogo).toBeNull();
    // Another organisation's look is its own.
    const theirs = await outsider.agent.get('/api/v1/auth/me').expect(200);
    expect(theirs.body.theme).toEqual({ default: 'system', accent: 'brand' });
    expect(await auditActions(t.owner, tenant.id)).toContain('tenant.updated');
  });

  it('takes a main colour white text cannot be read on (it is darkened), but not an unreadable side panel', async () => {
    const light = await patch(owner, {
      branding: { theme: { default: 'light', accent: 'brand', primary: '#ffd400' } },
    });
    expect(light.status).toBe(200);
    const unreadable = await patch(owner, {
      branding: {
        theme: {
          default: 'light',
          accent: 'brand',
          sidebar: { background: '#ffffff', text: '#eeeeee' },
        },
      },
    });
    expect(unreadable.status).toBe(400);
    expect(unreadable.body.code).toBe('THEME_CONTRAST');
    expect(unreadable.body.failures[0]).toMatchObject({ pair: 'text on the side panel' });
    for (const theme of [
      { primary: '#ffd40' },
      { primary: 'red' },
      { accentColor: 'url(javascript:alert(1))' },
      { sidebar: { background: '#000000', text: '#ffffff', image: 'x' } },
      { radius: '3px' },
      { appLogo: 'hidden' },
      { css: 'body{display:none}' },
    ])
      expect((await patch(owner, { branding: { theme } })).status, JSON.stringify(theme)).toBe(400);
    expect(
      (await patch(interviewer, { branding: { theme: { default: 'light', primary: '#000000' } } }))
        .status,
    ).toBe(403);
    const read = await owner.agent.get('/api/v1/tenant').expect(200);
    expect(read.body.branding.theme).toEqual({
      default: 'light',
      accent: 'brand',
      primary: '#ffd400',
    });
  });

  it('takes a PNG, JPEG or WebP logo with its description, and nothing that could run', async () => {
    expect((await sendLogo(interviewer, PNG, 'logo.png', 'Demo')).status).toBe(403);
    // The description is required.
    const noAlt = await sendLogo(owner, PNG, 'logo.png');
    expect(noAlt.status).toBe(400);
    expect(noAlt.body.code).toBe('LOGO_ALT_REQUIRED');
    expect((await sendLogo(owner, PNG, 'logo.png', '   ')).status).toBe(400);
    // SVG (scripts), GIF and anything else are refused by their bytes, whatever the name says.
    for (const [body, name] of [
      [SVG, 'logo.svg'],
      [SVG, 'logo.png'],
      [GIF, 'logo.gif'],
      [Buffer.from('just some text, long enough'), 'logo.png'],
    ] as const) {
      const res = await sendLogo(owner, body, name, 'Demo');
      expect(res.status, name).toBe(422);
      expect(res.body.code).toBe('NOT_AN_IMAGE');
    }
    const tooBig = await sendLogo(
      owner,
      Buffer.concat([PNG, Buffer.alloc(600 * 1024)]),
      'big.png',
      'Demo',
    );
    expect(tooBig.status).toBe(413);
    expect((await owner.agent.get('/api/v1/tenant').expect(200)).body.logo).toBeNull();

    expect((await sendLogo(owner, WEBP, 'logo.webp', 'Demo')).status).toBe(200);
    const up = await sendLogo(owner, PNG, 'logo.png', ' Instituto Demo ');
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body.logo).toEqual({ alt: 'Instituto Demo', updatedAt: expect.any(String) });
  });

  it('shows the logo to everyone of the organisation, and only to them', async () => {
    const me = await interviewer.agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.orgLogo).toEqual({
      url: expect.stringMatching(/^\/api\/v1\/tenant\/logo\?v=\d+$/),
      alt: 'Instituto Demo',
    });
    const img = await interviewer.agent.get(me.body.orgLogo.url as string).expect(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(img.headers['content-security-policy']).toContain("default-src 'none'");
    expect(Buffer.compare(img.body as Buffer, PNG)).toBe(0);
    // Another organisation has none; nobody signed out gets it.
    expect((await outsider.agent.get('/api/v1/tenant/logo')).status).toBe(404);
    expect((await request(t.app.getHttpServer()).get('/api/v1/tenant/logo')).status).toBe(401);
  });

  it('changes the description, and removes the logo', async () => {
    expect((await patch(owner, { logoAlt: '' })).status).toBe(400);
    expect((await patch(interviewer, { logoAlt: 'Other' })).status).toBe(403);
    const alt = await patch(owner, { logoAlt: 'Instituto Demo de Estadística' });
    expect(alt.status).toBe(200);
    expect(alt.body.logo.alt).toBe('Instituto Demo de Estadística');
    expect(
      (await interviewer.agent.delete('/api/v1/tenant/logo').set('x-csrf-token', interviewer.csrf))
        .status,
    ).toBe(403);
    const gone = await owner.agent.delete('/api/v1/tenant/logo').set('x-csrf-token', owner.csrf);
    expect(gone.status).toBe(200);
    expect(gone.body.logo).toBeNull();
    expect((await owner.agent.get('/api/v1/tenant/logo')).status).toBe(404);
    expect((await owner.agent.get('/api/v1/auth/me')).body.orgLogo).toBeNull();
    // Without a logo there is nothing to describe.
    const none = await patch(owner, { logoAlt: 'Instituto' });
    expect(none.status).toBe(409);
    expect(none.body.code).toBe('NO_LOGO');
    const res = await sql<{ details: string }>`
      SELECT details FROM audit_log
      WHERE tenant_id = ${tenant.id} AND action = 'tenant.updated'`.execute(t.owner);
    const details = res.rows.map((r) => r.details).join('\n');
    expect(details).toContain('"logo":"image/png"');
    expect(details).toContain('"logo":null');
    expect(details).toContain('Instituto Demo de Estadística');
  });

  it('says nothing about any organisation before signing in when there are several', async () => {
    const anon = request(t.app.getHttpServer());
    const look = await anon.get('/api/v1/public/org-look');
    expect(look.status).toBe(404);
    expect(look.body.code).toBe('NOT_SINGLE_TENANT');
    expect((await anon.get('/api/v1/public/org-look/logo')).status).toBe(404);
  });
});
