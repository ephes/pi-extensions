export interface ModelRef {
  provider: string;
  id: string;
}

export interface ResolvedAgentModel {
  requestedModel?: string;
  resolvedModel?: string;
  warning?: string;
}

export function formatModelRef(model: ModelRef): string {
  return `${model.provider}/${model.id}`;
}

export function resolveAgentModel(
  requestedModel: string | undefined,
  availableModels: ModelRef[],
  currentModel?: ModelRef,
): ResolvedAgentModel {
  const normalizedRequestedModel = requestedModel?.trim() || undefined;

  if (normalizedRequestedModel) {
    const exactMatch = availableModels.find((model) => formatModelRef(model) === normalizedRequestedModel);
    if (exactMatch) {
      return {
        requestedModel: normalizedRequestedModel,
        resolvedModel: formatModelRef(exactMatch),
      };
    }
  }

  if (currentModel) {
    const currentSessionMatch = availableModels.find(
      (model) => model.provider === currentModel.provider && model.id === currentModel.id,
    );
    if (currentSessionMatch) {
      return {
        requestedModel: normalizedRequestedModel,
        resolvedModel: formatModelRef(currentSessionMatch),
        warning: normalizedRequestedModel
          ? `Requested model ${normalizedRequestedModel} is unavailable; falling back to current session model ${formatModelRef(currentSessionMatch)}.`
          : undefined,
      };
    }
  }

  const firstAvailableModel = availableModels[0];
  if (firstAvailableModel) {
    return {
      requestedModel: normalizedRequestedModel,
      resolvedModel: formatModelRef(firstAvailableModel),
      warning: normalizedRequestedModel
        ? `Requested model ${normalizedRequestedModel} is unavailable; falling back to ${formatModelRef(firstAvailableModel)}.`
        : `No agent-specific model was configured; using ${formatModelRef(firstAvailableModel)}.`,
    };
  }

  return {
    requestedModel: normalizedRequestedModel,
    warning: normalizedRequestedModel
      ? `Requested model ${normalizedRequestedModel} is unavailable and no authenticated Pi models are configured. Run /login or configure an API key.`
      : "No authenticated Pi models are configured. Run /login or configure an API key.",
  };
}
