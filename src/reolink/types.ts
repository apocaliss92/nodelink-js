export interface ReolinkDeviceInfo {
  type?: string;
  hardwareVersion?: string;
  firmwareVersion?: string;
  itemNo?: string;
  serialNumber?: string;
  name?: string;
}

export type ReolinkDeviceInfoTag = keyof ReolinkDeviceInfo;
