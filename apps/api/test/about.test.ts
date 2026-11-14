import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { AboutController } from '../src/health/about.controller.js';

const about = (c: Partial<AppConfig>) => new AboutController(c as AppConfig).about();

describe('the public about answer', () => {
  it('says who runs the installation and which outside services are on', () => {
    expect(
      about({
        ORG_NAME: 'Instituto Demo',
        PRIVACY_CONTACT: 'datos@demo.example',
        GEOCODER: 'none',
        SMS_PROVIDER: 'acs',
        APP_AUTHOR: 'Ana Autora',
        APP_HOLDER: 'Editorial S.A.',
      }),
    ).toMatchObject({
      organisation: 'Instituto Demo',
      author: 'Ana Autora',
      holder: 'Editorial S.A.',
      privacyContact: 'datos@demo.example',
      services: { geocoder: false, sms: true, microsoftSignIn: false },
    });
  });

  it('leaves the organisation out when none is set, and claims no service that is off', () => {
    const a = about({ GEOCODER: 'nominatim', SMS_PROVIDER: 'console', ENTRA_CLIENT_ID: 'x' });
    expect(a.organisation).toBeNull();
    expect(a.privacyContact).toBeNull();
    expect(a.author).toBeNull();
    expect(a.holder).toBeNull();
    expect(a.services).toEqual({ geocoder: true, sms: false, microsoftSignIn: true });
    expect(a.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
