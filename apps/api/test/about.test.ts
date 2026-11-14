import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { AboutController, SystemController } from '../src/health/about.controller.js';

const about = (c: Partial<AppConfig>) => new AboutController(c as AppConfig).about();
const technical = (c: Partial<AppConfig>) => new SystemController(c as AppConfig).technical();

describe('the public about answer', () => {
  it('says who runs the installation and which outside services are on', () => {
    expect(
      about({
        ORG_NAME: 'Instituto Demo',
        PRIVACY_CONTACT: 'datos@demo.example',
        GEOCODER: 'none',
        SMS_PROVIDER: 'acs',
        APP_HOLDER: 'Editorial S.A.',
      }),
    ).toMatchObject({
      organisation: 'Instituto Demo',
      author: 'Juan Francisco Medina',
      holder: 'Editorial S.A.',
      privacyContact: 'datos@demo.example',
      services: { geocoder: false, sms: true, microsoftSignIn: false },
    });
  });

  it('leaves the organisation out when none is set, and claims no service that is off', () => {
    const a = about({
      GEOCODER: 'nominatim',
      SMS_PROVIDER: 'console',
      ENTRA_CLIENT_ID: 'x',
      PASSWORD_LOGIN: true,
    });
    expect(a.organisation).toBeNull();
    expect(a.privacyContact).toBeNull();
    // The author is a fixed fact of the project: shown even when nothing is set.
    expect(a.author).toBe('Juan Francisco Medina');
    expect(a.holder).toBeNull();
    expect(a.services).toEqual({
      geocoder: true,
      sms: false,
      email: false,
      microsoftSignIn: true,
      passwordLogin: true,
    });
    expect(a.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('keeps the build, the environment and the runtime out of the public answer', () => {
    const a = about({ APP_BUILD: 'abc123', NODE_ENV: 'production' });
    expect(Object.keys(a).sort()).toEqual(
      ['author', 'holder', 'organisation', 'privacyContact', 'services', 'version'].sort(),
    );
    expect(JSON.stringify(a)).not.toMatch(/abc123|production|node/i);
    expect(technical({ APP_BUILD: 'abc123', NODE_ENV: 'production' })).toMatchObject({
      build: 'abc123',
      environment: 'production',
    });
    expect(technical({ NODE_ENV: 'test' }).build).toMatch(/^\d+\.\d+\.\d+/);
    expect(technical({ NODE_ENV: 'test' }).environment).toBe('development');
  });
});
