from dataclasses import dataclass, field
from typing import Callable

import anthropic
import openai

from cvsmart.shared.errors import RunCancelled

# Kimi K3 (Moonshot) expose une API compatible OpenAI : on bascule de client
# selon le modele choisi, sans toucher au reste de la pipeline.
# Kimi K3 est accessible chez plusieurs fournisseurs, avec des identifiants
# de modele ET des endpoints differents -- une cle de l'un ne fonctionne pas
# chez l'autre (erreur 401). Les deux configurations connues :
#   Moonshot (platform.kimi.ai) : "kimi-k3"            + api.moonshot.ai/v1
#   Baseten                      : "moonshotai/Kimi-K3" + inference.baseten.co/v1
MODEL = "kimi-k3.1-pro"
IS_MOONSHOT = "kimi" in MODEL.lower()
MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1"

# Tarifs par million de tokens, pour estimer le cout reel : les figer sur un
# seul modele sous-estimait la facture des qu'on en changeait.
PRICING = {
    "claude-opus-5": {"in": 5, "out": 25},
    "claude-sonnet-5": {"in": 3, "out": 15},
    "claude-fable-5": {"in": 10, "out": 50},
    "kimi-k3.1-pro": {"in": 2, "out": 10, "cache": 0.2},
    "kimi-k3": {"in": 3, "out": 15},
    "moonshotai/Kimi-K3": {"in": 3, "out": 15},
}
RATE = PRICING.get(MODEL, PRICING["claude-sonnet-5"])

MOONSHOT_EFFORTS = {"low", "high", "max"}


@dataclass
class PassUsage:
    step: str
    effort: str
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    cost_usd: float


@dataclass
class ModelClient:
    """Appelle Claude ou Kimi/Moonshot selon MODEL, en streaming, avec suivi
    du cout par passe. on_progress/on_stream ont la meme signature que cote
    Node (step, message) / (step, kind, text)."""

    api_key: str
    on_progress: Callable[[str, str], None] = lambda step, message: None
    on_stream: Callable[[str, str, str], None] = lambda step, kind, text: None
    should_cancel: Callable[[], bool] = lambda: False

    total_input_tokens: int = field(default=0, init=False)
    total_output_tokens: int = field(default=0, init=False)
    total_cache_read_tokens: int = field(default=0, init=False)
    total_cache_write_tokens: int = field(default=0, init=False)
    per_pass_usage: list[PassUsage] = field(default_factory=list, init=False)

    def __post_init__(self):
        self._anthropic = None if IS_MOONSHOT else anthropic.Anthropic(api_key=self.api_key)
        self._moonshot = (
            openai.OpenAI(
                api_key=self.api_key,
                base_url=MOONSHOT_BASE_URL,
                # 40 minutes : Kimi produit ~48 tokens/s, et une passe 1 avec
                # reflexion approfondie depasse regulierement 20 minutes.
                timeout=40 * 60,
            )
            if IS_MOONSHOT
            else None
        )

    @staticmethod
    def _to_openai_content(blocks: list[dict]) -> list[dict]:
        """Traduit les blocs de contenu Anthropic vers le format OpenAI
        attendu par l'API Moonshot : le texte reste du texte, une image
        base64 devient une data URL. cache_control n'a pas d'equivalent et
        disparait -- la mise en cache est automatique cote Moonshot."""
        out = []
        for b in blocks:
            if b["type"] == "image":
                media_type = b["source"]["media_type"]
                data = b["source"]["data"]
                out.append({"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{data}"}})
            else:
                out.append({"type": "text", "text": b["text"]})
        return out

    def _call_moonshot(self, step: str, content: list[dict], max_tokens: int, effort: str) -> dict:
        stream = self._moonshot.chat.completions.create(
            model=MODEL,
            max_tokens=max_tokens,
            reasoning_effort=effort if effort in MOONSHOT_EFFORTS else "high",
            # Cle de cache stable par passe : le cache est facture 0.30 $/M
            # contre 3 $/M en entree. Elle ne change rien au contenu envoye.
            prompt_cache_key=f"cvsmart-{step}",
            stream=True,
            stream_options={"include_usage": True},
            messages=[{"role": "user", "content": self._to_openai_content(content)}],
        )
        text_buf, thinking_buf = "", ""
        usage = None
        finish_reason = None
        for chunk in stream:
            if self.should_cancel():
                stream.close()
                raise RunCancelled()
            if chunk.usage:
                usage = chunk.usage
            if chunk.choices and chunk.choices[0].finish_reason:
                finish_reason = chunk.choices[0].finish_reason
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            reasoning = getattr(delta, "reasoning_content", None)
            if reasoning:
                thinking_buf += reasoning
                self.on_stream(step, "thinking", thinking_buf[-4000:])
            if delta.content:
                text_buf += delta.content
                self.on_stream(step, "text", text_buf[-4000:])

        cached = 0
        if usage and usage.prompt_tokens_details:
            cached = usage.prompt_tokens_details.cached_tokens or 0
        return {
            "text": text_buf,
            "finish_reason": finish_reason,
            "input_tokens": (usage.prompt_tokens if usage else 0) - cached,
            "output_tokens": usage.completion_tokens if usage else 0,
            "cache_read": cached,
            "cache_write": 0,
        }

    def call(self, step: str, content: list[dict], max_tokens: int = 64000, effort: str = "high") -> str:
        self.on_progress(step, f"Appel a {MODEL} (effort {effort})...")

        if IS_MOONSHOT:
            r = self._call_moonshot(step, content, max_tokens, effort)
            self.total_input_tokens += r["input_tokens"]
            self.total_output_tokens += r["output_tokens"]
            self.total_cache_read_tokens += r["cache_read"]
            cost = round(
                (r["input_tokens"] * RATE["in"] + r["output_tokens"] * RATE["out"] + r["cache_read"] * RATE.get("cache", 0.3)) / 1e6, 4
            )
            self.per_pass_usage.append(PassUsage(
                step=step, effort=effort, input_tokens=r["input_tokens"], output_tokens=r["output_tokens"],
                cache_read_tokens=r["cache_read"], cache_write_tokens=0, cost_usd=cost,
            ))
            self.on_progress(
                step,
                f"Tokens: +{r['input_tokens']} in / +{r['output_tokens']} out (~${cost}) "
                f"[fin: {r['finish_reason'] or '?'}]",
            )
            if r["finish_reason"] == "length":
                raise RuntimeError(
                    f"Passe {step} : reponse coupee au plafond de {r['output_tokens']} tokens de sortie "
                    f'(finish_reason="length"). Le modele n\'a pas eu la place d\'ecrire le code apres avoir '
                    f"reflechi. Ce n'est pas un depassement de delai : l'API a bien repondu."
                )
            return r["text"]

        # Chemin Claude (actuellement inactif : MODEL="kimi-k3.1-pro" ci-dessus).
        # Porte a l'identique de callClaude cote Node pour parite si le
        # modele est change, mais pas exerce en production aujourd'hui.
        thinking_buf, text_buf = "", ""
        with self._anthropic.messages.stream(
            model=MODEL,
            max_tokens=max_tokens,
            output_config={"effort": effort},
            messages=[{"role": "user", "content": content}],
        ) as stream:
            for event in stream:
                if self.should_cancel():
                    raise RunCancelled()
                if event.type != "content_block_delta":
                    continue
                if event.delta.type == "thinking_delta":
                    thinking_buf += event.delta.thinking
                    self.on_stream(step, "thinking", thinking_buf[-4000:])
                elif event.delta.type == "text_delta":
                    text_buf += event.delta.text
                    self.on_stream(step, "text", text_buf[-4000:])
            msg = stream.get_final_message()

        self.total_input_tokens += msg.usage.input_tokens
        self.total_output_tokens += msg.usage.output_tokens
        cache_read = msg.usage.cache_read_input_tokens or 0
        cache_write = msg.usage.cache_creation_input_tokens or 0
        self.total_cache_read_tokens += cache_read
        self.total_cache_write_tokens += cache_write
        cost = round((
            msg.usage.input_tokens * RATE["in"] + msg.usage.output_tokens * RATE["out"]
            + cache_write * RATE["in"] * 1.25 + cache_read * RATE["in"] * 0.1
        ) / 1e6, 4)
        self.per_pass_usage.append(PassUsage(
            step=step, effort=effort, input_tokens=msg.usage.input_tokens, output_tokens=msg.usage.output_tokens,
            cache_read_tokens=cache_read, cache_write_tokens=cache_write, cost_usd=cost,
        ))
        cache_note = f" (cache: +{cache_write} ecrits, +{cache_read} lus)" if (cache_read or cache_write) else ""
        self.on_progress(
            step,
            f"Tokens: +{msg.usage.input_tokens} in / +{msg.usage.output_tokens} out (~${cost}){cache_note} "
            f"(cumule: {self.total_input_tokens} in / {self.total_output_tokens} out)",
        )
        return "".join(b.text for b in msg.content if b.type == "text")
