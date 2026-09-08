"""Motor de módulos de comportamiento.

Consume el track stream que ya produce video_loop() en backend.py (YOLO + tracking + pose)
y decide qué eventos disparar, por zona, según la configuración en zone_modules.
"""

from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass
class Event:
    type: str
    track_id: str
    zone_id: str
    explanation: str
    severity: str = "medium"


@dataclass
class TrackContext:
    track_id: str
    keypoints: object
    box: object
    center: tuple
    current_time: float
    p_state: object  # PersonState de backend.py
    detected_objects: list = field(default_factory=list)
    # Calculados una vez por persona por frame (no por zona) en video_loop(),
    # via compute_hip_motion() -- ver nota en WallClimbingModule.
    hip_y: float = None
    vertical_speed: float = 0.0


def compute_hip_motion(keypoints, p_state, current_time):
    """Calcula la posición y velocidad vertical de la cadera, mutando el estado
    de la persona UNA sola vez. Se llama una vez por persona por frame en
    video_loop(), antes de iterar zonas -- si WallClimbingModule hiciera esta
    mutación dentro de analyze(), una segunda zona en el mismo frame vería
    prev_hip_y ya actualizado por la primera y calcularía velocidad 0."""
    if len(keypoints) < 13:
        return None, 0.0
    left_hip = keypoints[11]
    right_hip = keypoints[12]
    if left_hip[1] == 0 or right_hip[1] == 0:
        return None, 0.0
    hip_y = (left_hip[1] + right_hip[1]) / 2

    vertical_speed = 0.0
    if p_state.prev_hip_time:
        dt = current_time - p_state.prev_hip_time
        if dt > 0:
            # y decreciente = moviéndose hacia arriba en la imagen
            vertical_speed = (p_state.prev_hip_y - hip_y) / dt

    p_state.prev_hip_y = hip_y
    p_state.prev_hip_time = current_time
    return hip_y, vertical_speed


class BehaviorModule:
    module_id: str

    def analyze(self, ctx: TrackContext, zone_id: str, zone_polygon: list, params: dict) -> list:
        raise NotImplementedError


class LoiteringModule(BehaviorModule):
    module_id = "loitering"

    def analyze(self, ctx: TrackContext, zone_id: str, zone_polygon: list, params: dict) -> list:
        if len(zone_polygon) < 3:
            return []

        inside = cv2.pointPolygonTest(np.array(zone_polygon), ctx.center, False) >= 0
        entry_times = ctx.p_state.roi_entry_times

        if not inside:
            entry_times.pop(zone_id, None)
            ctx.p_state.last_dwell_durations.pop(zone_id, None)
            return []

        if zone_id not in entry_times:
            entry_times[zone_id] = ctx.current_time

        dwell_seconds = params.get("dwell_seconds", 5.0)
        duration = ctx.current_time - entry_times[zone_id]
        ctx.p_state.last_dwell_durations[zone_id] = duration

        if duration > dwell_seconds:
            return [Event(
                type="loitering",
                track_id=ctx.track_id,
                zone_id=zone_id,
                explanation="SOSPECHA DE MERODEO",
                severity="medium",
            )]
        return []


class ZoneIntrusionModule(BehaviorModule):
    module_id = "zone_intrusion"

    def analyze(self, ctx: TrackContext, zone_id: str, zone_polygon: list, params: dict) -> list:
        if len(ctx.keypoints) < 11:
            return []

        left_wrist = ctx.keypoints[9]
        right_wrist = ctx.keypoints[10]
        reaching = False

        if left_wrist[0] > 0 and left_wrist[1] > 0 and len(zone_polygon) >= 3:
            if cv2.pointPolygonTest(np.array(zone_polygon), (int(left_wrist[0]), int(left_wrist[1])), False) >= 0:
                reaching = True
        if right_wrist[0] > 0 and right_wrist[1] > 0 and len(zone_polygon) >= 3:
            if cv2.pointPolygonTest(np.array(zone_polygon), (int(right_wrist[0]), int(right_wrist[1])), False) >= 0:
                reaching = True

        if reaching:
            return [Event(
                type="zone_intrusion",
                track_id=ctx.track_id,
                zone_id=zone_id,
                explanation="INTRUSIÓN EN ZONA RESTRINGIDA",
                severity="high",
            )]
        return []


class ConcealmentModule(BehaviorModule):
    module_id = "concealment"

    def _check_object_in_hand(self, keypoints, object_boxes, hand):
        if len(keypoints) < 11:
            return False
        wrist = keypoints[9] if hand == "LEFT" else keypoints[10]
        if wrist[0] == 0:
            return False
        for box in object_boxes:
            box_cx = (box[0] + box[2]) / 2
            box_cy = (box[1] + box[3]) / 2
            dist = np.sqrt((wrist[0] - box_cx) ** 2 + (wrist[1] - box_cy) ** 2)
            if dist < 120:
                return True
            if box[0] < wrist[0] < box[2] and box[1] < wrist[1] < box[3]:
                return True
        return False

    def _check_concealment(self, keypoints, reaching_hand):
        if len(keypoints) < 13:
            return False
        left_hip = keypoints[11]
        right_hip = keypoints[12]
        target_wrist = keypoints[9] if reaching_hand == "LEFT" else keypoints[10]
        if target_wrist[0] == 0 or left_hip[0] == 0 or right_hip[0] == 0:
            return False
        hip_center_x = (left_hip[0] + right_hip[0]) / 2
        hip_center_y = (left_hip[1] + right_hip[1]) / 2
        dist_x = target_wrist[0] - hip_center_x
        dist_y = target_wrist[1] - hip_center_y
        distance = np.sqrt(dist_x ** 2 + dist_y ** 2)
        hip_width = np.abs(left_hip[0] - right_hip[0])
        threshold = max(hip_width * 1.5, 100)
        return distance < threshold

    def analyze(self, ctx: TrackContext, zone_id: str, zone_polygon: list, params: dict) -> list:
        p_state = ctx.p_state
        left_has_obj = self._check_object_in_hand(ctx.keypoints, ctx.detected_objects, "LEFT")
        right_has_obj = self._check_object_in_hand(ctx.keypoints, ctx.detected_objects, "RIGHT")
        current_holding = left_has_obj or right_has_obj
        holding_hand = "LEFT" if left_has_obj else "RIGHT" if right_has_obj else None

        if current_holding:
            p_state.holding_object = True
            p_state.last_holding_time = ctx.current_time
            p_state.holding_hand = holding_hand
            return []

        if p_state.holding_object and not current_holding:
            time_since_hold = ctx.current_time - p_state.last_holding_time
            if time_since_hold < 3.0:
                hand_to_check = p_state.holding_hand
                if hand_to_check and self._check_concealment(ctx.keypoints, hand_to_check):
                    p_state.holding_object = False
                    return [Event(
                        type="concealment",
                        track_id=ctx.track_id,
                        zone_id=zone_id,
                        explanation="ROBO CONFIRMADO (ARTÍCULO OCULTADO)",
                        severity="high",
                    )]
            else:
                p_state.holding_object = False
                p_state.holding_hand = None
        return []


class WallClimbingModule(BehaviorModule):
    module_id = "wall_climbing"

    def analyze(self, ctx: TrackContext, zone_id: str, zone_polygon: list, params: dict) -> list:
        # hip_y/vertical_speed ya vienen calculados por compute_hip_motion(), una
        # sola vez por persona por frame -- ver docstring de esa función.
        if ctx.hip_y is None:
            return []

        wall_height_px = params.get("wall_height_px", 200)
        climb_speed_threshold = params.get("climb_speed_threshold", 15.0)

        if ctx.hip_y < wall_height_px and ctx.vertical_speed > climb_speed_threshold:
            return [Event(
                type="wall_climbing",
                track_id=ctx.track_id,
                zone_id=zone_id,
                explanation="ESCALAMIENTO DE MURO DETECTADO",
                severity="high",
            )]
        return []


MODULE_REGISTRY = {
    "loitering": LoiteringModule(),
    "zone_intrusion": ZoneIntrusionModule(),
    "wall_climbing": WallClimbingModule(),
    "concealment": ConcealmentModule(),
}
