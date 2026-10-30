// WanSurvey on one Azure App Service (Linux, Premium v3 P0v3: 1 vCPU, 4 GB): one Web App with
// three containers (sidecars). The web container (nginx) is the main one and the only one
// reached from outside, on 8080; it serves the app and proxies /api and /health to the API
// sidecar on localhost:3000. The worker sidecar runs the background jobs and answers /health
// on 3001. See docs/azure.md for the sizes behind the defaults below.
//
//   az deployment group create -g <group> -f infra/azure/main.bicep \
//     -p name=wansurvey acrName=<registry> imageTag=<tag> databaseUrl=… redisUrl=… …
//
// PostgreSQL Flexible Server, Azure Cache for Redis and the container registry are created
// apart (they outlive deployments); migrations run before each release (docs/azure.md).

@description('Base name of the plan and the app.')
param name string = 'wansurvey'
param location string = resourceGroup().location

@description('Plan size. P0v3 (1 vCPU, 4 GB) by default; P1v3 (2 vCPU, 8 GB) for large waves.')
@allowed(['P0v3', 'P1v3', 'P1mv3', 'P2v3'])
param sku string = 'P0v3'

@description('Instances autoscale may reach on CPU (each one runs all three containers). Keep instances × (DB_POOL_MAX + DB_WORKER_POOL_MAX + 2 health probes) under the database\'s user connections: 2 fits a Burstable B1ms (35).')
@minValue(1)
@maxValue(10)
param maxInstances int = 2

@description('Existing Azure Container Registry holding wansurvey-web and wansurvey-api.')
param acrName string
param imageTag string

@description('Public address of the app (custom domain), e.g. https://encuestas.example.org.')
param publicUrl string

@secure()
@description('postgres://wansurvey_app:…@<server>.postgres.database.azure.com:5432/wansurvey?sslmode=require, or a Key Vault reference.')
param databaseUrl string
@secure()
@description('rediss://:<key>@<name>.redis.cache.windows.net:6380, or a Key Vault reference.')
param redisUrl string
@secure()
@description('32 bytes, base64, or a Key Vault reference: @Microsoft.KeyVault(SecretUri=…).')
param encryptionKey string
@secure()
param smtpUrl string = ''
param mailFrom string = ''

@description('Organisation (slug) whose people sign in with the Microsoft button; its directory is the ENTRA_* below.')
param ssoDefaultOrg string = ''
@description('Microsoft Entra directory (tenant) id of the app registration.')
param entraTenantId string = ''
@description('Application (client) id of the app registration.')
param entraClientId string = ''
@secure()
@description('Client secret of the app registration, or a Key Vault reference.')
param entraClientSecret string = ''
@description('E-mail domains of that directory, comma-separated, e.g. poderjudicial.gob.do.')
param entraAllowedDomains string = ''
@description('With passwordLogin true: require Microsoft in ssoDefaultOrg too (its owners keep a password).')
param entraEnforce bool = false
@description('false: Microsoft sign-in only (no passwords, no password reset); needs ssoDefaultOrg and the four entra* values, or the API refuses to start.')
param passwordLogin bool = true

@description('Storage account for export files: 3-24 lowercase letters and digits, unique in Azure.')
param storageName string = take('${toLower(replace(name, '-', ''))}${uniqueString(resourceGroup().id)}', 24)

@description('Extra app settings (name: value), e.g. SSO or retention settings.')
param extraSettings object = {}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

// The app pulls its images with this identity (AcrPull), with no registry password.
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${name}-id'
  location: location
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, 'acrpull')
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d'
    )
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Export files, written by the worker as they are built and read back by the API; reached
// with the app's identity only (no account keys, no public blobs).
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource exportsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: 'exports'
  properties: {
    publicAccess: 'None'
  }
}

// The app deletes files after EXPORT_RETENTION_DAYS (7); this catches any it missed.
resource exportsLifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-exports'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: ['exports/']
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 8
                }
              }
            }
          }
        }
      ]
    }
  }
}

// Storage Blob Data Contributor: read, write and delete the export files.
resource blobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, identity.id, 'blobcontributor')
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
    )
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: '${name}-plan'
  location: location
  kind: 'linux'
  sku: {
    name: sku
    capacity: 1
  }
  properties: {
    reserved: true
  }
}

// The Microsoft button's directory, only when given (an empty setting is not a valid one).
var entraSettings = empty(ssoDefaultOrg)
  ? {}
  : {
      SSO_DEFAULT_ORG: ssoDefaultOrg
      ENTRA_TENANT_ID: entraTenantId
      ENTRA_CLIENT_ID: entraClientId
      ENTRA_CLIENT_SECRET: entraClientSecret
      ENTRA_REDIRECT_URI: '${publicUrl}/api/v1/auth/sso/callback'
      ENTRA_ALLOWED_DOMAINS: entraAllowedDomains
      ENTRA_ENFORCE: entraEnforce ? 'true' : 'false'
    }

// Every container sees every app setting; a container overrides one by pointing a variable
// at another setting (the API's PORT and each Node process's heap below).
var settings = union(
  {
    NODE_ENV: 'production'
    DATABASE_URL: databaseUrl
    REDIS_URL: redisUrl
    APP_ENCRYPTION_KEY: encryptionKey
    PUBLIC_WEB_URL: publicUrl
    MAILER: empty(smtpUrl) ? 'console' : 'smtp'
    SMTP_URL: smtpUrl
    MAIL_FROM: mailFrom
    // Export files in Blob Storage (AZURE_CLIENT_ID, the identity reaching it, is set below).
    EXPORT_STORAGE: 'blob'
    EXPORT_BLOB_URL: 'https://${storageName}.blob.${environment().suffixes.storage}/exports'
    PASSWORD_LOGIN: passwordLogin ? 'true' : 'false'
    // nginx → API on the same host; App Service front end → nginx → API.
    API_UPSTREAM: 'http://localhost:3000'
    TRUST_PROXY_HOPS: '2'
    API_PORT: '3000'
    WORKER_HEALTH_PORT: '3001'
    // 4 GB for the three containers: about 1 GB of heap for the API, 1.25 GB for the worker
    // (exports are built in memory, scans are read with pdftoppm), the rest for the platform,
    // pdftoppm and Node's memory outside the heap.
    API_NODE_OPTIONS: '--max-old-space-size=1024'
    WORKER_NODE_OPTIONS: '--max-old-space-size=1280'
    DB_POOL_MAX: '9'
    DB_WORKER_POOL_MAX: '5'
    JOB_CONCURRENCY: '4'
    HEAVY_JOB_CONCURRENCY: '1'
    // About 5 requests waiting per pooled connection, then 503 with Retry-After: past that,
    // waiting only ends in the front end's 230 s timeout.
    MAX_CONCURRENT_REQUESTS: '50'
    WEBSITES_ENABLE_APP_SERVICE_STORAGE: 'false'
    // Health check: an instance is taken out of rotation after 5 failed pings (one a minute).
    WEBSITE_HEALTHCHECK_MAXPINGFAILURES: '5'
  },
  entraSettings,
  extraSettings
)

var settingList = [for s in items(settings): { name: s.key, value: string(s.value) }]

resource site 'Microsoft.Web/sites@2024-11-01' = {
  name: name
  location: location
  kind: 'app,linux,container'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'SITECONTAINERS'
      alwaysOn: true
      healthCheckPath: '/health'
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      acrUseManagedIdentityCreds: true
      acrUserManagedIdentityID: identity.properties.clientId
      // The identity's client id is known only once it exists: added after the loop.
      appSettings: concat(settingList, [{ name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }])
    }
  }
  dependsOn: [acrPull]
}

var images = registry.properties.loginServer

resource web 'Microsoft.Web/sites/sitecontainers@2024-11-01' = {
  parent: site
  name: 'web'
  properties: {
    image: '${images}/wansurvey-web:${imageTag}'
    isMain: true
    targetPort: '8080'
    authType: 'UserAssigned'
    userManagedIdentityClientId: identity.properties.clientId
  }
}

resource api 'Microsoft.Web/sites/sitecontainers@2024-11-01' = {
  parent: site
  name: 'api'
  properties: {
    image: '${images}/wansurvey-api:${imageTag}'
    isMain: false
    targetPort: '3000'
    authType: 'UserAssigned'
    userManagedIdentityClientId: identity.properties.clientId
    // Values name app settings, resolved when the container starts.
    environmentVariables: [
      { name: 'PORT', value: 'API_PORT' }
      { name: 'NODE_OPTIONS', value: 'API_NODE_OPTIONS' }
    ]
  }
}

resource worker 'Microsoft.Web/sites/sitecontainers@2024-11-01' = {
  parent: site
  name: 'worker'
  properties: {
    image: '${images}/wansurvey-api:${imageTag}'
    isMain: false
    targetPort: '3001'
    startUpCommand: 'node dist/worker.js'
    authType: 'UserAssigned'
    userManagedIdentityClientId: identity.properties.clientId
    environmentVariables: [{ name: 'NODE_OPTIONS', value: 'WORKER_NODE_OPTIONS' }]
  }
}

// One instance at rest; more while the CPU stays high (fieldwork peaks), fewer when it drops.
resource autoscale 'Microsoft.Insights/autoscalesettings@2022-10-01' = if (maxInstances > 1) {
  name: '${name}-autoscale'
  location: location
  properties: {
    enabled: true
    targetResourceUri: plan.id
    profiles: [
      {
        name: 'cpu'
        capacity: { minimum: '1', maximum: string(maxInstances), default: '1' }
        rules: [
          {
            metricTrigger: {
              metricName: 'CpuPercentage'
              metricResourceUri: plan.id
              timeGrain: 'PT1M'
              statistic: 'Average'
              timeWindow: 'PT10M'
              timeAggregation: 'Average'
              operator: 'GreaterThan'
              threshold: 70
            }
            scaleAction: { direction: 'Increase', type: 'ChangeCount', value: '1', cooldown: 'PT10M' }
          }
          {
            metricTrigger: {
              metricName: 'CpuPercentage'
              metricResourceUri: plan.id
              timeGrain: 'PT1M'
              statistic: 'Average'
              timeWindow: 'PT20M'
              timeAggregation: 'Average'
              operator: 'LessThan'
              threshold: 30
            }
            scaleAction: { direction: 'Decrease', type: 'ChangeCount', value: '1', cooldown: 'PT20M' }
          }
        ]
      }
    ]
  }
}

output url string = 'https://${site.properties.defaultHostName}'
