"""Bake sculpted detail into a normal map the low-poly export can carry.

A sculpt exported as-is is a multi-million-triangle mesh no runtime wants, and
a decimated mesh has lost the polish. A normal-map bake is the step between:
the cage keeps its cheap topology, the image carries the surface. This is a
render-device operation, not a bmesh one -- Cycles needs UVs, a bake target
image and selected-to-active -- so it lives beside the render helpers.
"""

import os
import time

# pi-lens-ignore: ast-grep:unresolved-import-python
import bpy  # pyright: ignore[reportMissingImports]


def _triangle_count(obj):
    if obj.type != "MESH":
        return 0
    return sum(max(0, len(poly.vertices) - 2) for poly in obj.data.polygons)


def _ensure_uv(obj):
    if obj.data.uv_layers:
        return False
    bpy.context.view_layer.objects.active = obj
    for other in bpy.context.selected_objects:
        other.select_set(False)
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    try:
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.02)
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")
    return True


def _bake_target(low, image_name, resolution):
    material = low.data.materials[0] if low.data.materials else None
    if material is None:
        material = bpy.data.materials.new(f"{low.name}_baked")
        material.use_nodes = True
        low.data.materials.append(material)
    if not material.use_nodes:
        material.use_nodes = True
    nodes = material.node_tree.nodes
    target = nodes.get("BakeTarget")
    if target is None:
        target = nodes.new("ShaderNodeTexImage")
        target.name = "BakeTarget"
        target.location = (-420, 320)
    image = bpy.data.images.get(image_name)
    if image is None:
        image = bpy.data.images.new(image_name, width=resolution, height=resolution, alpha=False)
    elif image.size[0] != resolution or image.size[1] != resolution:
        image.scale(resolution, resolution)
    image.colorspace_settings.name = "Non-Color"
    target.image = image
    nodes.active = target

    # The bake writes the pixels; without this link the exported material still
    # has a flat normal and the detail exists only in the image.
    normal_map = nodes.get("BakedNormalMap")
    if normal_map is None:
        normal_map = nodes.new("ShaderNodeNormalMap")
        normal_map.name = "BakedNormalMap"
    bsdf = next((node for node in nodes if node.type == "BSDF_PRINCIPLED"), None)
    if bsdf is not None:
        material.node_tree.links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    material.node_tree.links.new(target.outputs["Color"], normal_map.inputs["Color"])
    return material, image


def bake_normal(
    low,
    high,
    output_path,
    resolution=1024,
    samples=64,
    cage_extrusion=None,
    margin=16,
):
    """Bake `high`'s surface into a normal map on `low`.

    Returns the measurements a critic needs: face counts on both sides, the
    actual resolution and sample count, and how long it took. Raises with those
    same numbers in the message, because the common failure is a bake that ran
    past the caller's budget and the first question is what it was asked to do.
    """
    if low is None or high is None:
        raise ValueError("bake_normal needs both a low-poly cage and a high-poly source")
    if low.type != "MESH" or high.type != "MESH":
        raise ValueError(f"bake_normal needs meshes; got {low.type} and {high.type}")
    if resolution < 16 or resolution > 8192:
        raise ValueError(f"resolution {resolution} is outside 16..8192")
    if samples < 1 or samples > 4096:
        raise ValueError(f"samples {samples} is outside 1..4096")

    previously_selected = [obj for obj in bpy.context.selected_objects]
    previous_active = bpy.context.view_layer.objects.active
    output_path = os.path.abspath(output_path)
    try:
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
    except OSError as error:
        raise RuntimeError(f"Normal bake could not create the output directory for {output_path}: {error}") from error
    low_triangles = _triangle_count(low)
    high_triangles = _triangle_count(high)

    scene = bpy.context.scene
    previous_engine = scene.render.engine
    try:
        previous_samples = getattr(scene.cycles, "samples", None)
        previous_device = getattr(scene.cycles, "device", None)
    except AttributeError as error:
        raise RuntimeError("normal bake needs the Cycles addon enabled") from error
    bake = scene.render.bake
    previous_bake = {
        "use_selected_to_active": bake.use_selected_to_active,
        "cage_extrusion": bake.cage_extrusion,
        "margin": bake.margin,
    }

    used_cage = cage_extrusion if cage_extrusion is not None else max(0.001, low.dimensions.length * 0.02)
    started = time.monotonic()
    try:
        created_uv = _ensure_uv(low)
        material, image = _bake_target(low, f"{low.name}_normal", resolution)
        for other in bpy.context.selected_objects:
            other.select_set(False)
        low.select_set(True)
        high.select_set(True)
        bpy.context.view_layer.objects.active = low
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.samples = samples
        bake.use_selected_to_active = True
        bake.cage_extrusion = used_cage
        bake.margin = margin
        try:
            bpy.ops.object.bake(type="NORMAL")
        except RuntimeError as error:
            raise RuntimeError(
                f"Normal bake failed at {resolution}x{resolution} with {samples} samples "
                f"({low_triangles} -> {high_triangles} triangles): {error}. "
                "Lower resolution or samples, or widen cage_extrusion."
            ) from error
        try:
            image.filepath_raw = output_path
            image.file_format = "PNG"
            image.save()
            image.pack()
        except (OSError, RuntimeError) as error:
            raise RuntimeError(f"Normal bake could not write {output_path} at {resolution}x{resolution} with {samples} samples: {error}") from error
        if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
            raise RuntimeError(f"Normal bake wrote no PNG at {output_path} at {resolution}x{resolution} with {samples} samples")
        elapsed = time.monotonic() - started
    finally:
        # Engine, bake settings and selection are all process-wide state: a
        # failure halfway through must not change the next render's cost or look.
        scene.render.engine = previous_engine
        if previous_samples is not None:
            scene.cycles.samples = previous_samples
        if previous_device is not None:
            scene.cycles.device = previous_device
        bake.use_selected_to_active = previous_bake["use_selected_to_active"]
        bake.cage_extrusion = previous_bake["cage_extrusion"]
        bake.margin = previous_bake["margin"]
        for other in bpy.context.selected_objects:
            other.select_set(False)
        for obj in previously_selected:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = previous_active

    return {
        "imagePath": output_path,
        "imageName": image.name,
        "materialName": material.name,
        "resolution": resolution,
        "samples": samples,
        "elapsedSeconds": round(elapsed, 2),
        "lowTriangles": low_triangles,
        "highTriangles": high_triangles,
        "triangleReduction": (
            round(1.0 - low_triangles / high_triangles, 4) if high_triangles else 0.0
        ),
        "uvCreated": created_uv,
        "cageExtrusion": round(used_cage, 5),
        "margin": margin,
    }


CHANNEL_COLOR_SPACE = {
    "base_color": "sRGB",
    "emission": "sRGB",
    "roughness": "Non-Color",
    "metallic": "Non-Color",
    "ao": "Non-Color",
    "normal": "Non-Color",
}

CHANNEL_SOCKET = {
    "base_color": "Base Color",
    "roughness": "Roughness",
    "metallic": "Metallic",
    "emission": "Emission Color",
}


def _estimate_bake_seconds(resolution, samples, channels):
    pixels = resolution * resolution
    return max(1.0, pixels * samples * len(channels) / 900000.0)


def _principled(material):
    return next((node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"), None)


def _material_output(material):
    return next((node for node in material.node_tree.nodes if node.type == "OUTPUT_MATERIAL"), None)


def _bake_image(target, channel, resolution, output_dir):
    name = f"{target.name}_{channel}"
    image = bpy.data.images.get(name)
    if image is None:
        image = bpy.data.images.new(name, width=resolution, height=resolution, alpha=False)
    elif image.size[0] != resolution or image.size[1] != resolution:
        image.scale(resolution, resolution)
    image.colorspace_settings.name = CHANNEL_COLOR_SPACE[channel]
    path = os.path.join(output_dir, f"{name}.png")
    return image, path


def _target_node(material, channel, image):
    nodes = material.node_tree.nodes
    name = f"Baked_{channel}"
    node = nodes.get(name)
    if node is None:
        node = nodes.new("ShaderNodeTexImage")
        node.name = name
        node.location = (-620, 420 - 220 * list(CHANNEL_COLOR_SPACE).index(channel))
    node.image = image
    nodes.active = node
    return node


def _with_emission_source(material, socket):
    """Route `socket` through an emission shader for an EMIT bake."""
    tree = material.node_tree
    output = _material_output(material)
    if output is None or socket is None:
        raise RuntimeError("the material has no surface output or emission socket to bake")
    emission = tree.nodes.new("ShaderNodeEmission")
    emission.name = "PI_BakeEmission"
    original_links = [(link.from_socket, link.to_socket) for link in output.inputs["Surface"].links]
    for _from_socket, to_socket in original_links:
        for link in list(to_socket.links):
            tree.links.remove(link)
    if socket.is_linked:
        tree.links.new(socket.links[0].from_socket, emission.inputs["Color"])
    else:
        value = socket.default_value
        if isinstance(value, float):
            value = (value, value, value, 1.0)
        emission.inputs["Color"].default_value = value
    tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])

    def restore():
        for link in list(output.inputs["Surface"].links):
            tree.links.remove(link)
        for from_socket, to_socket in original_links:
            tree.links.new(from_socket, to_socket)
        tree.nodes.remove(emission)

    return restore


def _attach_ao(tree, node):
    group = bpy.data.node_groups.get("glTF Material Output")
    if group is None:
        group = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
        group.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    holder = tree.nodes.get("BakedAO")
    if holder is None:
        holder = tree.nodes.new("ShaderNodeGroup")
        holder.name = "BakedAO"
        holder.node_tree = group
        holder.location = (-620, -220)
    tree.links.new(node.outputs["Color"], holder.inputs["Occlusion"])


def _attach_baked(material, nodes):
    tree = material.node_tree
    for channel, node in nodes.items():
        if channel == "ao":
            _attach_ao(tree, node)
            continue
        if channel == "normal":
            normal_map = tree.nodes.get("BakedNormalMap")
            if normal_map is None:
                normal_map = tree.nodes.new("ShaderNodeNormalMap")
                normal_map.name = "BakedNormalMap"
            tree.links.new(node.outputs["Color"], normal_map.inputs["Color"])
            bsdf = _principled(material)
            if bsdf is not None:
                for link in list(bsdf.inputs["Normal"].links):
                    tree.links.remove(link)
                tree.links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
            continue
        socket = CHANNEL_SOCKET.get(channel)
        bsdf = _principled(material)
        if socket and bsdf is not None and socket in bsdf.inputs:
            for link in list(bsdf.inputs[socket].links):
                tree.links.remove(link)
            tree.links.new(node.outputs["Color"], bsdf.inputs[socket])


def bake_textures(target, channels=None, resolution=512, samples=32, margin=8, output_dir=None, time_budget_seconds=None):
    """Bake PBR channels from a material into packed images.

    Channels are baked in one pass with one engine switch. Colour space is set
    on the image at bake time because an sRGB roughness map looks right in
    Blender and wrong in every engine that reads it as data.
    """
    channels = list(channels or ["base_color", "roughness", "ao", "normal"])
    unknown = [channel for channel in channels if channel not in CHANNEL_COLOR_SPACE]
    if unknown:
        raise ValueError(f"unknown bake channel(s) {unknown}; expected {sorted(CHANNEL_COLOR_SPACE)}")
    if target is None or target.type != "MESH":
        raise ValueError("bake_textures needs a mesh target")
    if len(target.data.materials) > 1:
        raise ValueError(
            f"bake_textures bakes one material and {target.name} has {len(target.data.materials)}; "
            "split the mesh or make the target single-material before baking"
        )
    if not target.data.uv_layers:
        raise ValueError(
            f"bake_textures needs UVs on {target.name}: unwrap it first "
            "(bpy.ops.uv.smart_project) or run the density pass before baking"
        )
    if resolution < 16 or resolution > 8192:
        raise ValueError(f"resolution {resolution} is outside 16..8192")
    if samples < 1 or samples > 4096:
        raise ValueError(f"samples {samples} is outside 1..4096")
    estimate = _estimate_bake_seconds(resolution, samples, channels)
    if time_budget_seconds is not None and estimate > float(time_budget_seconds):
        raise ValueError(
            f"bake would take about {estimate:.0f}s at {resolution}x{resolution} with "
            f"{samples} samples for {len(channels)} channel(s), over the "
            f"{float(time_budget_seconds):.0f}s budget; lower resolution or samples"
        )

    material = target.active_material
    if material is None:
        material = bpy.data.materials.new(f"{target.name}_baked")
        target.data.materials.append(material)
    material.use_nodes = True
    output_dir = os.path.abspath(output_dir or os.path.join(os.getcwd(), "textures"))
    try:
        os.makedirs(output_dir, exist_ok=True)
    except OSError as error:
        raise RuntimeError(f"bake could not create {output_dir}: {error}") from error

    scene = bpy.context.scene
    previous_engine = scene.render.engine
    try:
        previous_samples = int(scene.cycles.samples)
        previous_device = scene.cycles.device
    except AttributeError as error:
        raise RuntimeError("bake_textures needs the Cycles addon enabled") from error
    bake = scene.render.bake
    previous_bake = {
        "use_selected_to_active": bake.use_selected_to_active,
        "margin": bake.margin,
        "use_pass_direct": bake.use_pass_direct,
        "use_pass_indirect": bake.use_pass_indirect,
        "use_pass_color": bake.use_pass_color,
    }
    selected = list(bpy.context.selected_objects)
    active = bpy.context.view_layer.objects.active
    results = []
    nodes = {}
    switched = previous_engine != "CYCLES"
    started_all = time.monotonic()
    try:
        for other in bpy.context.selected_objects:
            other.select_set(False)
        target.select_set(True)
        bpy.context.view_layer.objects.active = target
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.samples = samples
        bake.use_selected_to_active = False
        bake.margin = margin
        bake.use_pass_direct = False
        bake.use_pass_indirect = False
        bake.use_pass_color = True

        for channel in channels:
            if time_budget_seconds is not None and time.monotonic() - started_all > float(time_budget_seconds):
                done = ", ".join(entry["channel"] for entry in results) or "none"
                raise RuntimeError(
                    f"bake exceeded its {float(time_budget_seconds):.0f}s budget after {done}; "
                    "lower resolution, samples or channel count"
                )
            image, path = _bake_image(target, channel, resolution, output_dir)
            node = _target_node(material, channel, image)
            nodes[channel] = node
            restore = None
            started = time.monotonic()
            try:
                if channel == "base_color":
                    bsdf = _principled(material)
                    if bsdf is None:
                        raise RuntimeError("the material has no Principled BSDF")
                    restore = _with_emission_source(material, bsdf.inputs.get("Base Color"))
                    bpy.ops.object.bake(type="EMIT")
                elif channel == "roughness":
                    bpy.ops.object.bake(type="ROUGHNESS")
                elif channel == "normal":
                    bpy.ops.object.bake(type="NORMAL")
                elif channel == "ao":
                    bpy.ops.object.bake(type="AO")
                else:
                    bsdf = _principled(material)
                    if bsdf is None:
                        raise RuntimeError("the material has no Principled BSDF")
                    socket_name = "Emission Color" if channel == "emission" else "Metallic"
                    restore = _with_emission_source(material, bsdf.inputs.get(socket_name))
                    bpy.ops.object.bake(type="EMIT")
            except RuntimeError as error:
                raise RuntimeError(
                    f"{channel} bake failed at {resolution}x{resolution} with {samples} samples: {error}"
                ) from error
            finally:
                if restore is not None:
                    restore()
            elapsed = round(time.monotonic() - started, 2)
            image.filepath_raw = path
            image.file_format = "PNG"
            image.save()
            image.pack()
            if not os.path.exists(path) or os.path.getsize(path) == 0:
                raise RuntimeError(f"{channel} bake wrote no PNG at {path}")
            results.append({
                "channel": channel,
                "imagePath": path,
                "imageName": image.name,
                "resolution": resolution,
                "colorSpace": image.colorspace_settings.name,
                "linked": True,
                "elapsedSeconds": elapsed,
            })
        _attach_baked(material, nodes)
    finally:
        scene.render.engine = previous_engine
        scene.cycles.samples = previous_samples
        scene.cycles.device = previous_device
        bake.use_selected_to_active = previous_bake["use_selected_to_active"]
        bake.margin = previous_bake["margin"]
        bake.use_pass_direct = previous_bake["use_pass_direct"]
        bake.use_pass_indirect = previous_bake["use_pass_indirect"]
        bake.use_pass_color = previous_bake["use_pass_color"]
        for other in bpy.context.selected_objects:
            other.select_set(False)
        for obj in selected:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = active
        restored = scene.render.engine == previous_engine

    return {
        "materialName": material.name,
        "targetName": target.name,
        "resolution": resolution,
        "samples": samples,
        "uvCreated": False,
        "engineSwitched": switched,
        "engineRestored": restored,
        "estimatedSeconds": round(estimate, 1),
        "channels": results,
    }
