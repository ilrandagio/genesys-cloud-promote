/** Dominio Genesys Cloud -> regione AWS usata dal provider Terraform (GENESYSCLOUD_REGION). */
export const REGIONS: Record<string, string> = {
  'mypurecloud.com': 'us-east-1',
  'usw2.pure.cloud': 'us-west-2',
  'cac1.pure.cloud': 'ca-central-1',
  'sae1.pure.cloud': 'sa-east-1',
  'mypurecloud.ie': 'eu-west-1',
  'euw2.pure.cloud': 'eu-west-2',
  'mypurecloud.de': 'eu-central-1',
  'euc2.pure.cloud': 'eu-central-2',
  'mec1.pure.cloud': 'me-central-1',
  'aps1.pure.cloud': 'ap-south-1',
  'mypurecloud.jp': 'ap-northeast-1',
  'apne2.pure.cloud': 'ap-northeast-2',
  'apne3.pure.cloud': 'ap-northeast-3',
  'mypurecloud.com.au': 'ap-southeast-2',
};

export function awsRegion(domain: string): string {
  const r = REGIONS[domain];
  if (!r) throw new Error(`Regione sconosciuta: ${domain}`);
  return r;
}
