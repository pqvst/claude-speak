// Shapes of the stream-json protocol frames the extension relays. Only the
// fields this server actually reads — the real frames carry much more.

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: any;
}

export interface Frame {
  type?: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  created_at?: string;
  cwd?: string;
  status_detail?: string;
  message?: { content?: ContentBlock[] };
  // control_request frames (permission prompts) carry these instead.
  request_id?: string;
  request?: {
    subtype?: string;
    tool_name?: string;
    display_name?: string;
    description?: string;
    requires_user_interaction?: boolean;
    input?: any;
  };
}
