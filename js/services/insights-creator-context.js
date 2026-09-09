let context = {channelTopic: "", channelContext: ""};

export function setCreatorContext(value = {}) {
  context = {
    channelTopic: String(value.channelTopic || ""),
    channelContext: String(value.channelContext || "")
  };
}

export function getCreatorContext() {
  return context;
}
