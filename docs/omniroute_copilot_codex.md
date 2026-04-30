# How to use VSCode GitHub Copilot + Relief Pilot via OmniRoute integration and ChatGPT/Codex or similar subscriptions

1) Install [OmniRoute](https://github.com/diegosouzapw/OmniRoute) following their instructions and connect the provider with your coding subscription

2) Add a new provider for your IDE version in the [GitHub Copilot settings](https://code.visualstudio.com/docs/copilot/customization/language-models):

    - VSCode + "Azure" and the corresponding models following the example in chatLanguageModels.json:

    ```json
    {
        "name": "OmniRoute",
        "vendor": "azure",
        "apiKey": "${input:chat.lm.secret.-<WILL BE SUBSTITUTED AUTOMATICALLY>}",
        "models": [
        {
            "id": "cx/gpt-5.4-mini",
            "name": "cx/gpt-5.4-mini",
            "url": "https://<your omniroute address>/v1/responses#models.ai.azure.com",
            "toolCalling": true,
            "vision": true,
            "thinking": true,
            "maxInputTokens": 258400,
            "maxOutputTokens": 128000
        },
        {
            "id": "cx/gpt-5.5-xhigh",
            "name": "cx/gpt-5.5-xhigh",
            "url": "https://<your omniroute address>/v1/responses#models.ai.azure.com",
            "toolCalling": true,
            "vision": true,
            "thinking": true,
            "maxInputTokens": 258400,
            "maxOutputTokens": 128000
        }
        ]
    }

    ```

    - VSCode Insiders + "CustomOAI" and the corresponding models following the example in chatLanguageModels.json:

    ```json
    {
        "name": "OmniRoute",
        "vendor": "customoai",
        "apiKey": "${input:chat.lm.secret.-<WILL BE SUBSTITUTED AUTOMATICALLY>}",
        "models": [
        {
            "id": "cx/gpt-5.4-mini",
            "name": "cx/gpt-5.4-mini",
            "url": "https://<your omniroute address>/v1/responses",
            "toolCalling": true,
            "vision": true,
            "thinking": true,
            "maxInputTokens": 258400,
            "maxOutputTokens": 128000
        },
        {
            "id": "cx/gpt-5.5-xhigh",
            "name": "cx/gpt-5.5-xhigh",
            "url": "https://<your omniroute address>/v1/responses",
            "toolCalling": true,
            "vision": true,
            "thinking": true,
            "maxInputTokens": 258400,
            "maxOutputTokens": 128000
        }
        ]
    }

    ```

3) Select the corresponding model in the Relief Pilot settings: "Select model for `ai_fetch_url`"
