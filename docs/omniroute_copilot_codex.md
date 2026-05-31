# How to use VSCode GitHub Copilot + Relief Pilot via OmniRoute integration and ChatGPT/Codex or similar subscriptions

1) Install [OmniRoute](https://github.com/diegosouzapw/OmniRoute) v3.8.6+ following their instructions and connect the provider with your coding subscription

2) Add a new provider for your IDE version in the [GitHub Copilot settings](https://code.visualstudio.com/docs/copilot/customization/language-models):

    - VSCode 1.122+ "customendpoint" and the corresponding models following the example in chatLanguageModels.json:

    ```json
    {
        "name": "OmniRoute",
		"vendor": "customendpoint",
        "apiKey": "${input:chat.lm.secret.-<WILL BE SUBSTITUTED AUTOMATICALLY>}",
		"apiType": "responses",
        "models": [
        {
            "id": "cx/gpt-5.4-mini",
            "name": "cx/gpt-5.4-mini",
            "url": "https://<your omniroute address>/v1/responses",
            "supportsReasoningEffort": [
                "none",
                "low",
                "medium",
                "high",
                "xhigh"
            ],
            "reasoningEffortFormat": "responses",
            "toolCalling": true,
            "vision": true,
            "thinking": true,
            "maxInputTokens": 258400,
            "maxOutputTokens": 128000,
            "zeroDataRetentionEnabled": true
        },
        {
            "id": "cx/gpt-5.5-xhigh",
            "name": "cx/gpt-5.5-xhigh",
            "url": "https://<your omniroute address>/v1/responses",
            "supportsReasoningEffort": [
                "none",
                "low",
                "medium",
                "high",
                "xhigh"
            ],
            "reasoningEffortFormat": "responses",
            "toolCalling": true,
            "vision": true,
            "thinking": true,
            "maxInputTokens": 258400,
            "maxOutputTokens": 128000,
            "zeroDataRetentionEnabled": true
        },
        {
            "id": "cc/claude-opus-4-8",
            "name": "cc/claude-opus-4-8",
            "url": "https://<your omniroute address>/v1/responses",
            "supportsReasoningEffort": [
                "none",
                "low",
                "medium",
                "high",
                "max"
            ],
            "reasoningEffortFormat": "responses",
            "toolCalling": true,
            "vision": true,
            "thinking": true,
            "maxInputTokens": 258400,
            "maxOutputTokens": 128000,
            "zeroDataRetentionEnabled": true
        },
        {
            "id": "ag/gemini-3.5-flash-agent",
            "name": "ag/gemini-3.5-flash-agent",
            "url": "https://<your omniroute address>/v1/responses",
            "supportsReasoningEffort": [
                "none",
                "low",
                "medium",
                "high",
                "max"
            ],
            "reasoningEffortFormat": "responses",
            "toolCalling": true,
            "vision": true,
            "thinking": true,
            "maxInputTokens": 258400,
            "maxOutputTokens": 128000,
            "zeroDataRetentionEnabled": true
        }
        ]
    }

    ```

3) Select the corresponding model in the Relief Pilot settings: "Select model for `ai_fetch_url`"
