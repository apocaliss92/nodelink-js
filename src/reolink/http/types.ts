export type ReolinkCmdRequest<TParam = unknown> = {
  cmd: string;
  action?: number;
  param?: TParam;
};

export type ReolinkCmdResponse<TValue = unknown> = {
  cmd: string;
  code: number;
  value?: TValue;
  error?: unknown;
};

export type ReolinkJson = ReolinkCmdResponse[];

export type LoginResponseValue = {
  Token: {
    name: string;
    leaseTime: number | string;
  };
};

