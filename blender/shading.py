"""Deterministic procedural material construction for module scripts."""

import hashlib
import json

import bpy  # pyright: ignore[reportMissingImports]

PRESETS = {
    "metal": {"metallic": 1.0, "roughness": 0.25},
    "dielectric": {"metallic": 0.0, "roughness": 0.5},
    "emission": {"metallic": 0.0, "roughness": 0.5, "emissionStrength": 2.0},
}

TEXTURE_TYPES = {
    "noise": "ShaderNodeTexNoise",
    "voronoi": "ShaderNodeTexVoronoi",
    "brick": "ShaderNodeTexBrick",
    "checker": "ShaderNodeTexChecker",
    "wave": "ShaderNodeTexWave",
    "gradient": "ShaderNodeTexGradient",
}

SAFE_GLTF_NODES = {
    "OUTPUT_MATERIAL",
    "BSDF_PRINCIPLED",
    "TEX_IMAGE",
    "NORMAL_MAP",
    "MAPPING",
    "TEX_COORD",
    "UVMAP",
    "BUMP",
}

TARGET_SOCKETS = {
    "base_color": "Base Color",
    "roughness": "Roughness",
    "metallic": "Metallic",
    "emission": "Emission Color",
    "alpha": "Alpha",
}


def _round(value):
    if isinstance(value, (list, tuple)):
        return [round(float(component), 6) for component in value]
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return round(float(value), 6)
    return value


def _number(value, label):
    try:
        return float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label} must be a number, got {value!r}") from None


def _color(value, default=(0.8, 0.8, 0.8, 1.0)):
    if value is None:
        return list(default)
    components = list(value)
    while len(components) < 4:
        components.append(1.0)
    return [float(component) for component in components[:4]]


def _emission_socket(bsdf):
    for name in ("Emission Color", "Emission"):
        if name in bsdf.inputs:
            return bsdf.inputs[name]
    return None


def _configure_texture(node, texture):
    kind = texture.get("kind", "noise")
    if kind == "noise":
        for name, key in (
            ("Scale", "scale"),
            ("Detail", "detail"),
            ("Roughness", "roughness"),
            ("Distortion", "distortion"),
            ("Lacunarity", "lacunarity"),
        ):
            if key in texture:
                node.inputs[name].default_value = float(texture[key])
    elif kind == "voronoi":
        if "feature" in texture:
            node.feature = str(texture["feature"]).upper()
        for name, key in (("Scale", "scale"), ("Detail", "detail"), ("Roughness", "roughness"), ("Randomness", "randomness")):
            if key in texture:
                node.inputs[name].default_value = float(texture[key])
    elif kind == "brick":
        for name, key in (
            ("Scale", "scale"),
            ("Mortar Size", "mortarSize"),
            ("Bias", "bias"),
            ("Brick Width", "brickWidth"),
            ("Row Height", "rowHeight"),
        ):
            if key in texture:
                node.inputs[name].default_value = float(texture[key])
    elif kind in {"checker", "wave"}:
        for name, key in (("Scale", "scale"), ("Distortion", "distortion"), ("Detail", "detail")):
            if key in texture and name in node.inputs:
                node.inputs[name].default_value = float(texture[key])
    elif kind == "gradient" and "gradientType" in texture:
        node.gradient_type = str(texture["gradientType"]).upper()
    return node


def _ramp_node(nodes, name, stops, interpolation="LINEAR"):
    node = nodes.new("ShaderNodeValToRGB")
    node.name = name
    elements = node.color_ramp.elements
    ordered = sorted(stops, key=lambda stop: float(stop["position"]))
    if not ordered:
        ordered = [
            {"position": 0.0, "color": [0.0, 0.0, 0.0, 1.0]},
            {"position": 1.0, "color": [1.0, 1.0, 1.0, 1.0]},
        ]
    while len(elements) > 1:
        elements.remove(elements[-1])
    elements[0].position = float(ordered[0]["position"])
    elements[0].color = _color(ordered[0].get("color"))
    for stop in ordered[1:]:
        element = elements.new(float(stop["position"]))
        element.color = _color(stop.get("color"))
    node.color_ramp.interpolation = str(interpolation).upper()
    return node


def _texture_output(node, texture):
    output = str(texture.get("output", "color"))
    return node.outputs["Color" if output == "color" else "Fac"]


def _mapping_node(nodes):
    mapping = nodes.new("ShaderNodeMapping")
    mapping.name = "Mapping"
    return mapping


def _coordinates(nodes, space):
    coordinates = nodes.new("ShaderNodeTexCoord")
    coordinates.name = "Coordinates"
    if space == "UV":
        uv = nodes.new("ShaderNodeUVMap")
        uv.name = "UVMap"
        uv.uv_map = "UVMap"
        return coordinates, uv.outputs["UV"]
    return coordinates, coordinates.outputs[space]


def _digest(nodes, links):
    node_records = []
    for node in sorted(nodes, key=lambda item: item.name):
        inputs = {}
        for socket in node.inputs:
            value = getattr(socket, "default_value", None)
            if value is None:
                continue
            try:
                inputs[socket.name] = _round(list(value))
            except TypeError:
                inputs[socket.name] = _round(value)
        record = {"name": node.name, "type": node.type, "inputs": inputs}
        if node.type == "VAL_TO_RGB":
            record["ramp"] = [
                {"position": _round(element.position), "color": _round(list(element.color))}
                for element in node.color_ramp.elements
            ]
            record["interpolation"] = node.color_ramp.interpolation
        for attribute in ("gradient_type", "feature", "wave_type", "noise_dimensions"):
            if hasattr(node, attribute):
                record[attribute] = str(getattr(node, attribute))
        node_records.append(record)
    link_records = sorted(
        (
            {"from": f"{link.from_node.name}.{link.from_socket.name}", "to": f"{link.to_node.name}.{link.to_socket.name}"}
            for link in links
        ),
        key=lambda item: (item["to"], item["from"]),
    )
    payload = json.dumps(
        {"nodes": node_records, "links": link_records},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def material_summary(material):
    """Describe what a material's graph is made of, without relying on names."""
    nodes = material.node_tree.nodes if material.use_nodes and material.node_tree else []
    types = [node.type for node in nodes]
    procedural = any(node_type not in SAFE_GLTF_NODES for node_type in types)
    images = sorted(node.image.name for node in nodes if node.type == "TEX_IMAGE" and node.image is not None)
    uv_dependent = any(node.type in {"TEX_IMAGE", "UVMAP"} for node in nodes)
    summary = {
        "name": material.name,
        "useNodes": bool(material.use_nodes),
        "procedural": procedural,
        "nodeCount": len(nodes),
        "imageNodes": images,
        "uvDependent": uv_dependent,
        "graphDigest": _digest(nodes, material.node_tree.links) if material.node_tree else None,
    }
    bsdf = next((node for node in nodes if node.type == "BSDF_PRINCIPLED"), None)
    if bsdf is not None:
        base = bsdf.inputs["Base Color"].default_value
        summary["baseColor"] = _round(list(base))
        summary["roughness"] = _round(bsdf.inputs["Roughness"].default_value)
        summary["metallic"] = _round(bsdf.inputs["Metallic"].default_value)
        emission = _emission_socket(bsdf)
        if emission is not None:
            summary["emissionColor"] = _round(list(emission.default_value))
        if "Emission Strength" in bsdf.inputs:
            summary["emissionStrength"] = _round(bsdf.inputs["Emission Strength"].default_value)
    return summary


def build_material(name, recipe):
    """Build (or rebuild) a named material from a recipe deterministically."""
    if not isinstance(name, str) or not name.strip():
        raise ValueError("build_material needs a non-empty material name")
    if not isinstance(recipe, dict):
        raise ValueError("build_material needs a recipe mapping")

    preset = str(recipe.get("preset", "dielectric"))
    if preset not in PRESETS:
        raise ValueError(f"unknown shading preset {preset!r}; expected one of {sorted(PRESETS)}")
    settings = dict(PRESETS[preset])
    settings.update({key: value for key, value in recipe.items() if key not in {"preset", "textures", "bump"}})

    material = bpy.data.materials.get(name)
    if material is None:
        material = bpy.data.materials.new(name)
    material.use_nodes = True
    tree = material.node_tree
    nodes, links = tree.nodes, tree.links
    nodes.clear()

    output = nodes.new("ShaderNodeOutputMaterial")
    output.name = "Output"
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.name = "Principled"
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])

    bsdf.inputs["Base Color"].default_value = _color(settings.get("baseColor"))
    bsdf.inputs["Roughness"].default_value = _number(settings.get("roughness", 0.5), "roughness")
    bsdf.inputs["Metallic"].default_value = _number(settings.get("metallic", 0.0), "metallic")
    emission = _emission_socket(bsdf)
    if emission is not None:
        emission.default_value = _color(settings.get("emissionColor"), (0.0, 0.0, 0.0, 1.0))
    if "Emission Strength" in bsdf.inputs:
        bsdf.inputs["Emission Strength"].default_value = _number(settings.get("emissionStrength", 0.0), "emissionStrength")

    space = str(recipe.get("coordinates", "Generated"))
    if space not in {"Object", "Generated", "UV"}:
        raise ValueError(f"coordinates must be Object, Generated or UV, got {space!r}")

    textures = list(recipe.get("textures") or [])
    bump = recipe.get("bump")
    mapping = None
    if textures or bump:
        _coordinates_node, vector = _coordinates(nodes, space)
        mapping = _mapping_node(nodes)
        links.new(vector, mapping.inputs["Vector"])
        mapping.inputs["Scale"].default_value = _round(settings.get("textureScale", [1.0, 1.0, 1.0]))
        mapping.inputs["Location"].default_value = _round(settings.get("textureLocation", [0.0, 0.0, 0.0]))
        mapping.inputs["Rotation"].default_value = _round(settings.get("textureRotation", [0.0, 0.0, 0.0]))

    if textures or bump:
        if mapping is None:
            raise RuntimeError("texture mapping was not built")
        for index, texture in enumerate(textures):
            kind = str(texture.get("kind", "noise"))
            if kind not in TEXTURE_TYPES:
                raise ValueError(f"unknown texture kind {kind!r}; expected one of {sorted(TEXTURE_TYPES)}")
            node = nodes.new(TEXTURE_TYPES[kind])
            node.name = f"Texture{index}_{kind.title()}"
            _configure_texture(node, texture)
            links.new(mapping.outputs["Vector"], node.inputs["Vector"])
            source = _texture_output(node, texture)
            if texture.get("ramp"):
                ramp_recipe = texture["ramp"]
                if isinstance(ramp_recipe, dict):
                    stops = ramp_recipe.get("stops") or []
                    interpolation = ramp_recipe.get("interpolation", "LINEAR")
                else:
                    stops = ramp_recipe
                    interpolation = "LINEAR"
                ramp = _ramp_node(nodes, f"Ramp{index}", stops, interpolation)
                links.new(source, ramp.inputs["Fac"])
                source = ramp.outputs["Color"]
            target = TARGET_SOCKETS.get(str(texture.get("target", "base_color")))
            if target is None or target not in bsdf.inputs:
                raise ValueError(f"unknown texture target {texture.get('target')!r}")
            links.new(source, bsdf.inputs[target])

        if bump:
            kind = str(bump.get("kind", "noise"))
            if kind not in {"noise", "voronoi"}:
                raise ValueError(f"bump kind must be noise or voronoi, got {kind!r}")
            height = nodes.new(TEXTURE_TYPES[kind])
            height.name = f"Bump_{kind.title()}"
            _configure_texture(height, bump)
            links.new(mapping.outputs["Vector"], height.inputs["Vector"])
            bump_node = nodes.new("ShaderNodeBump")
            bump_node.name = "Bump"
            bump_node.inputs["Strength"].default_value = _number(bump.get("strength", 0.2), "bump.strength")
            bump_node.inputs["Distance"].default_value = _number(bump.get("distance", 0.02), "bump.distance")
            links.new(height.outputs["Fac"], bump_node.inputs["Height"])
            links.new(bump_node.outputs["Normal"], bsdf.inputs["Normal"])

    material.diffuse_color = _color(settings.get("baseColor"))
    if hasattr(material, "metallic"):
        material.metallic = float(settings.get("metallic", 0.0))
    if hasattr(material, "roughness"):
        material.roughness = float(settings.get("roughness", 0.5))

    for node in nodes:
        node.location = (0.0, 0.0)
    summary = material_summary(material)
    summary["built"] = True
    return summary


def clamp01(value):
    return max(0.0, min(1.0, float(value)))


def mix(a, b, factor):
    return [clamp01(x + (y - x) * factor) for x, y in zip(a, b, strict=False)]
